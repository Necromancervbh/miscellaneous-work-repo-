import os
import logging
import json
from datetime import datetime, timedelta
from typing import List, Dict, Any

import numpy as np
import pandas as pd
from fastapi import FastAPI, Depends, HTTPException, Request, BackgroundTasks, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, Field, validator
import jwt
import asyncio
from sklearn.cluster import DBSCAN
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

# ----------------------------------------------------------------------
# Configuration and Logging
# ----------------------------------------------------------------------
SECRET_KEY = os.getenv("JWT_SECRET_KEY", "your-secret-key")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ----------------------------------------------------------------------
# FastAPI Application and Rate Limiter
# ----------------------------------------------------------------------
limiter = Limiter(key_func=get_remote_address, default_limits=["10/minute"])
app = FastAPI()
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# ----------------------------------------------------------------------
# Security (JWT) Utilities
# ----------------------------------------------------------------------
class TokenData(BaseModel):
    username: str | None = None
    exp: datetime | None = None

security = HTTPBearer()


def decode_jwt(token: str) -> TokenData:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return TokenData(username=payload.get("sub"), exp=datetime.fromtimestamp(payload.get("exp")))
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token expired")
    except jwt.PyJWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")


async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)) -> TokenData:
    if credentials.scheme.lower() != "bearer":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid authentication scheme")
    token = credentials.credentials
    token_data = decode_jwt(token)
    if token_data.exp and token_data.exp < datetime.utcnow():
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token expired")
    return token_data

# ----------------------------------------------------------------------
# Request / Response Models
# ----------------------------------------------------------------------
class TimeSeriesPayload(BaseModel):
    timestamps: List[datetime] = Field(..., description="List of ISO8601 timestamps")
    values: List[float] = Field(..., description="Corresponding numeric values")

    @validator("timestamps")
    def timestamps_must_match_values(cls, v, values):
        if "values" in values and len(v) != len(values["values"]):
            raise ValueError("timestamps and values must have the same length")
        return v

class AnomalyResponse(BaseModel):
    combined_scores: List[float] = Field(..., description="Combined anomaly scores per observation")
    model: str = Field(default="bayesian_ensemble", description="Ensemble model identifier")

# ----------------------------------------------------------------------
# Core Anomaly Detection Algorithms
# ----------------------------------------------------------------------
async def run_kalman_filter(series: pd.Series) -> List[float]:
    """
    Simple 1‑D Kalman filter.
    Equation:
        x̂ₖ = x̂ₖ₋₁ + Kₖ (zₖ - x̂ₖ₋₁)
        Pₖ = (1 - Kₖ) Pₖ₋₁ + Q
        Kₖ = Pₖ₋₁ / (Pₖ₋₁ + R)
    Returns normalized absolute residuals as anomaly scores (0‑1).
    """
    n = len(series)
    if n == 0:
        return []

    # Hyper‑parameters (tuned for generic data)
    Q = 1e-5  # process variance
    R = 0.01  # measurement variance

    x_est = series.iloc[0]  # initial state estimate
    P = 1.0                # initial estimate covariance

    scores = []
    for z in series:
        # Prediction step (identity model)
        x_pred = x_est
        P_pred = P + Q

        # Update step
        K = P_pred / (P_pred + R)
        x_est = x_pred + K * (z - x_pred)
        P = (1 - K) * P_pred

        # Residual (innovation)
        residual = abs(z - x_pred)
        scores.append(residual)

    # Normalize residuals to [0,1]
    scores_arr = np.array(scores)
    if scores_arr.max() == scores_arr.min():
        normalized = np.zeros_like(scores_arr)
    else:
        normalized = (scores_arr - scores_arr.min()) / (scores_arr.max() - scores_arr.min())
    return normalized.tolist()


async def run_dbscan(series: pd.Series) -> List[float]:
    """
    DBSCAN on 1‑D data.
    Points labeled as -1 (noise) are considered anomalies.
    Returns binary anomaly scores (0 or 1) converted to float.
    """
    if len(series) == 0:
        return []

    # Reshape for sklearn (n_samples, n_features)
    X = series.values.reshape(-1, 1)

    # Hyper‑parameters
    eps = np.std(series) * 0.5 if np.std(series) > 0 else 0.1
    min_samples = max(2, int(0.05 * len(series)))  # at least 5% of points

    clustering = DBSCAN(eps=eps, min_samples=min_samples).fit(X)
    labels = clustering.labels_

    # Noise points have label -1
    scores = [1.0 if label == -1 else 0.0 for label in labels]
    return scores

# ----------------------------------------------------------------------
# Bayesian Weighting Helper
# ----------------------------------------------------------------------
def bayesian_weighted_score(score1: float, score2: float, prior1: float = 0.5, prior2: float = 0.5) -> float:
    """
    Combine two probability scores using Bayesian weighting.
    Formula:
        combined = (p1 * w1) / (p1 * w1 + p2 * w2)
    where w1 and w2 are prior probabilities (default 0.5 each).
    """
    numerator = score1 * prior1
    denominator = numerator + score2 * prior2
    if denominator == 0:
        return 0.0
    return numerator / denominator

# ----------------------------------------------------------------------
#