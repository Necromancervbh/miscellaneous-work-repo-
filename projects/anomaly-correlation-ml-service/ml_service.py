import asyncio
import pickle
from typing import List, Optional, Tuple

import numpy as np
import uvicorn
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request, status
from pydantic import BaseModel, Field, validator
from pykalman import KalmanFilter
from sklearn.decomposition import PCA
import aioredis
from aioredis import Redis

# --------------------------- Configuration ---------------------------

REDIS_URL = "redis://localhost:6379/0"
MODEL_KEY = "kalman_model"
PCA_KEY = "pca_model"

# --------------------------- FastAPI App ---------------------------

app = FastAPI(title="Anomaly Correlation ML Service")

# --------------------------- Redis Connection ---------------------------

redis: Optional[Redis] = None


@app.on_event("startup")
async def startup_event():
    global redis
    redis = await aioredis.from_url(REDIS_URL, decode_responses=False)


@app.on_event("shutdown")
async def shutdown_event():
    if redis:
        await redis.close()


# --------------------------- Request / Response Models ---------------------------


class TimeSeriesRequest(BaseModel):
    data: List[List[float]] = Field(..., description="Time‑series matrix (time steps × features)")
    apply_pca: Optional[bool] = Field(False, description="Whether to apply PCA before training")
    n_components: Optional[int] = Field(
        None,
        description="Number of PCA components (required if apply_pca is true)",
        ge=1,
    )

    @validator("data")
    def validate_data(cls, v):
        if not v:
            raise ValueError("Data must contain at least one time step")
        row_len = len(v[0])
        if row_len == 0:
            raise ValueError("Each time step must contain at least one feature")
        for i, row in enumerate(v):
            if len(row) != row_len:
                raise ValueError(f"All rows must have the same length; row 0 has length {row_len} but row {i} has length {len(row)}")
        return v

    @validator("n_components")
    def validate_n_components(cls, v, values):
        if values.get("apply_pca"):
            if v is None:
                raise ValueError("n_components must be set when apply_pca is true")
        return v


class AnomalyResponse(BaseModel):
    scores: Optional[List[float]] = Field(
        None, description="Anomaly scores for each observation (None if model not ready)"
    )
    model_status: str = Field(..., description="Current status of the model (ready / training)")


# --------------------------- Helper Functions ---------------------------


def _apply_pca(data: np.ndarray, n_components: int) -> Tuple[np.ndarray, PCA]:
    """
    Apply PCA to reduce dimensionality.

    Formula:
        X_centered = X - μ
        C = (X_centered.T @ X_centered) / (n_samples - 1)
        C = U Σ Uᵀ   (eigen‑decomposition)
        X_pca = X_centered @ U_k
    """
    pca = PCA(n_components=n_components, svd_solver="full")
    transformed = pca.fit_transform(data)
    return transformed, pca


def _train_kalman_filter(data: np.ndarray) -> KalmanFilter:
    """
    Train a simple Kalman filter assuming identity transition and observation matrices.
    The filter parameters are estimated via EM algorithm.

    EM updates:
        - Transition matrix A
        - Observation matrix H
        - Transition covariance Q
        - Observation covariance R
        - Initial state mean μ₀ and covariance Σ₀
    """
    kf = KalmanFilter(
        transition_matrices=np.eye(data.shape[1]),
        observation_matrices=np.eye(data.shape[1]),
        em_vars=["transition_covariance", "observation_covariance", "initial_state_mean", "initial_state_covariance"],
    )
    kf = kf.em(data, n_iter=10)
    return kf


def _compute_anomaly_scores(data: np.ndarray, kf: KalmanFilter) -> List[float]:
    """
    Compute Mahalanobis distance of residuals as anomaly scores.

    For each time step t:
        residual_t = y_t - H * μ_{t|t-1}
        score_t = sqrt(residual_tᵀ Σ_t^{-1} residual_t)

    where Σ_t = H * P_{t|t-1} * Hᵀ + R
    """
    # Run the filter forward pass
    filtered_state_means, filtered_state_covariances = kf.filter(data)

    # Predict step (one step ahead)
    predicted_means = kf.transition_matrices @ filtered_state_means.T
    predicted_covs = (
        kf.transition_matrices @ filtered_state_covariances @ kf.transition_matrices.T
        + kf.transition_covariance
    )

    H = kf.observation_matrices
    R = kf.observation_covariance

    scores = []
    for t in range(data.shape[0]):
        pred_mean = H @ predicted_means[:, t]
        pred_cov = H @ predicted_covs[:, :, t] @ H.T + R
        residual = data[t] - pred_mean
        try:
            inv_cov = np.linalg.inv(pred_cov)
        except np.linalg.LinAlgError:
            inv_cov = np.linalg.pinv(pred_cov)
        mahal = np.sqrt(residual.T @ inv_cov @ residual)
        scores.append(float(mahal))
    return scores


async def _store_model(kf_bytes: bytes, pca_bytes: Optional[bytes]) -> None:
    """
    Store the serialized Kalman filter and optional