import logging
from datetime import datetime, timedelta
from typing import List, Tuple

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, validator
from scipy.stats import t

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Anomaly Correlation Forecasting Service")


class ForecastRequest(BaseModel):
    timestamps: List[datetime] = Field(..., description="List of ISO8601 timestamps")
    scores: List[float] = Field(..., description="Corresponding anomaly scores")

    @validator("timestamps")
    def timestamps_must_be_sorted(cls, v):
        if any(v[i] >= v[i + 1] for i in range(len(v) - 1)):
            raise ValueError("timestamps must be strictly increasing")
        return v

    @validator("scores")
    def scores_non_empty(cls, v):
        if not v:
            raise ValueError("scores list cannot be empty")
        return v

    @validator("scores")
    def scores_match_timestamps(cls, v, values):
        if "timestamps" in values and len(v) != len(values["timestamps"]):
            raise ValueError("scores and timestamps must have the same length")
        return v


class ForecastPoint(BaseModel):
    timestamp: datetime = Field(..., description="Forecast timestamp")
    mean: float = Field(..., description="Forecast mean value")
    lower: float = Field(..., description="Lower bound of confidence interval")
    upper: float = Field(..., description="Upper bound of confidence interval")


class ForecastResponse(BaseModel):
    forecasts: List[ForecastPoint] = Field(..., description="24‑hour ahead forecasts")


def kalman_smooth(
    measurements: np.ndarray, Q: float = 1e-5, R: float = 0.01
) -> np.ndarray:
    """
    Apply a 1‑dimensional Kalman filter to smooth the input series.

    Parameters
    ----------
    measurements : np.ndarray
        Observed anomaly scores.
    Q : float
        Process (model) variance. Small Q assumes the underlying state changes slowly.
    R : float
        Measurement variance. Larger R trusts measurements less.

    Returns
    -------
    np.ndarray
        Smoothed estimates of the same length as ``measurements``.
    """
    n = len(measurements)
    if n == 0:
        raise ValueError("No measurements provided for Kalman smoothing")

    # Initial state estimate and covariance
    x_est = measurements[0]
    P = 1.0

    smoothed = np.empty(n, dtype=float)
    smoothed[0] = x_est

    for k in range(1, n):
        # Predict
        x_pred = x_est
        P_pred = P + Q

        # Update
        K = P_pred / (P_pred + R)  # Kalman gain
        x_est = x_pred + K * (measurements[k] - x_pred)
        P = (1 - K) * P_pred

        smoothed[k] = x_est

    return smoothed


def bayesian_predictive(
    data: np.ndarray,
    steps: int = 24,
    confidence: float = 0.95,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Perform Bayesian updating with a Normal‑Inverse‑Gamma prior and return the
    predictive Student‑t distribution for future observations.

    The predictive distribution for a new observation is:
        X_new ~ t_{2α_n}(μ_n, σ²_pred)
    where
        σ²_pred = β_n (λ_n + 1) / (α_n λ_n)

    Parameters
    ----------
    data : np.ndarray
        Smoothed anomaly scores.
    steps : int
        Number of future points to forecast.
    confidence : float
        Desired confidence level for the interval (e.g., 0.95).

    Returns
    -------
    Tuple[np.ndarray, np.ndarray, np.ndarray]
        Arrays of length ``steps`` containing the mean forecast, lower bound,
        and upper bound of the confidence interval.
    """
    if data.size == 0:
        raise ValueError("No data provided for Bayesian inference")

    # Prior hyperparameters (weakly informative)
    mu0 = 0.0
    lambda0 = 1e-3
    alpha0 = 1e-3
    beta0 = 1e-3

    n = data.size
    sample_mean = np.mean(data)
    sample_var = np.var(data, ddof=1) if n > 1 else 0.0

    # Posterior hyperparameters
    lambda_n = lambda0 + n
    mu_n = (lambda0 * mu0 + n