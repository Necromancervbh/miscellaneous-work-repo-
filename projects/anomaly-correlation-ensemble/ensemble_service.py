import logging
from datetime import datetime
from typing import List, Optional, Tuple

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, validator
from scipy.stats import chi2
from sklearn.decomposition import PCA
from sklearn.cluster import KMeans

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Anomaly Correlation Ensemble Engine")


class TimeSeriesRequest(BaseModel):
    """
    Request payload for time‑series anomaly analysis.
    """
    data: List[float] = Field(..., description="Time‑series values.")
    timestamps: Optional[List[str]] = Field(
        None,
        description="ISO‑8601 timestamps corresponding to each data point. "
                    "If omitted, integer indices are used."
    )
    window_size: int = Field(
        30,
        ge=2,
        description="Size of the sliding window used for feature extraction."
    )
    n_clusters: int = Field(
        3,
        ge=1,
        description="Number of clusters for K‑Means."
    )
    top_k: int = Field(
        5,
        ge=1,
        description="Number of top anomalies to return."
    )

    @validator("timestamps")
    def timestamps_match_data(cls, v, values):
        if v is not None and len(v) != len(values.get("data", [])):
            raise ValueError("Length of timestamps must match length of data.")
        return v

    @validator("data")
    def data_not_empty(cls, v):
        if not v:
            raise ValueError("Data list cannot be empty.")
        return v


class AnomalyInsight(BaseModel):
    """
    Single anomaly insight returned to the client.
    """
    index: int = Field(..., description="Zero‑based index of the anomalous point.")
    timestamp: Optional[str] = Field(None, description="ISO‑8601 timestamp of the point.")
    score: float = Field(..., description="Combined anomaly score (higher = more anomalous).")
    bayesian_score: float = Field(..., description="Anomaly probability from Bayesian scoring.")
    kalman_residual: float = Field(..., description="Absolute residual from Kalman filter forecast.")


class TimeSeriesResponse(BaseModel):
    """
    Response payload containing ranked anomaly insights.
    """
    insights: List[AnomalyInsight] = Field(..., description="Ranked list of anomaly insights.")
    processed_at: datetime = Field(default_factory=datetime.utcnow)


def _create_lag_matrix(series: np.ndarray, window_size: int) -> np.ndarray:
    """
    Convert a 1‑D series into a 2‑D lag matrix.
    Each row i contains series[i : i + window_size].

    Formula:
        X[i, j] = series[i + j]   for 0 ≤ i < N - window_size + 1,
                                          0 ≤ j < window_size
    """
    n_rows = len(series) - window_size + 1
    if n_rows <= 0:
        raise ValueError("Window size too large for the length of the series.")
    return np.lib.stride_tricks.as_strided(
        series,
        shape=(n_rows, window_size),
        strides=(series.strides[0], series.strides[0])
    ).copy()


def _apply_pca(features: np.ndarray, n_components: int = 5) -> Tuple[np.ndarray, PCA]:
    """
    Reduce dimensionality of lag matrix using PCA.
    """
    pca = PCA(n_components=min(n_components, features.shape[1]))
    transformed = pca.fit_transform(features)
    return transformed, pca


def _cluster_features(features: np.ndarray, n_clusters: int) -> Tuple[np.ndarray, KMeans]:
    """
    Cluster PCA‑transformed features with K‑Means.
    """
    kmeans = KMeans(n_clusters=n_clusters, random_state=42, n_init="auto")
    labels = kmeans.fit_predict(features)
    return labels, kmeans


def _bayesian_anomaly_score(
    features: np.ndarray,
    labels: np.ndarray,
    n_clusters: int
) -> np.ndarray:
    """
    Compute Bayesian anomaly probability for each point.
    Assumes Gaussian distribution per cluster.

    Steps:
        1. For each cluster c compute mean μ_c and covariance Σ_c.
        2. Compute Mahalanobis distance d_i = (x_i-μ_c)^T Σ_c^{-1} (x_i-μ_c).
        3. Convert distance to p‑value using chi‑square CDF with d degrees of freedom.
        4. Anomaly probability = 1 - p‑value (higher means more anomalous).
    """
    dim = features.shape[1]
    probs = np.empty(len(features), dtype=float)

    for c in range(n_clusters):
        idx = np.where(labels == c)[0]
        if len(idx) < 2:
            # Not enough points to estimate covariance; assign low anomaly probability
            probs[idx] = 0.0
            continue
        cluster_feat = features[idx]
        mu = cluster_feat.mean(axis=0)
        cov = np.cov(cluster_feat, rowvar=False)
        # Regularize covariance to avoid singularity
        cov += np.eye(dim) * 1e-6
        inv_cov = np.linalg.inv(cov)
        diff = cluster_feat - mu
        mdist = np.einsum('ij,jk,ik->i', diff, inv_cov, diff)  # Mahalanobis distance
        p_vals = chi2.cdf(mdist, df=dim)
        probs[idx] = 1.0 - p_vals  # Higher probability = more anomalous

    return probs


class SimpleKalmanFilter:
    """
    One‑dimensional Kalman filter with constant velocity model.
    State vector: [position, velocity]^T
    """

    def __init__(self, process_variance: float = 1e-3, measurement_variance: float = 1e-1):
        # State transition matrix (Δt = 1)
        self.F = np.array([[1, 1],
                           [0, 1]], dtype=float)
        # Observation matrix
        self.H = np.array([[1, 0]], dtype=float)
        # Process noise covariance
        self.Q = process_variance * np.eye(2)
        # Measurement noise covariance
        self.R = np.array([[measurement_variance]], dtype=float)

        self.x = np.zeros((2, 1), dtype=float)  # Initial state
        self.P = np.eye(2)                     # Initial covariance

    def predict(self):
        self.x = self.F @ self.x
        self.P = self.F @ self.P