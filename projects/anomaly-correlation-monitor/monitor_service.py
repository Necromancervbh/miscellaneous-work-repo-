import math
import time
import uuid
from datetime import datetime, timedelta
from typing import List, Optional, Dict, Any

import jwt
import numpy as np
from cachetools import LRUCache
from fastapi import (
    FastAPI,
    HTTPException,
    Depends,
    status,
    BackgroundTasks,
    Request,
)
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, Field, validator

# -------------------- Configuration --------------------
JWT_SECRET_KEY = "your-secure-secret-key"
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60

# LRU cache for recent metrics (key: metric_id, value: Metric)
RECENT_METRICS_CACHE_SIZE = 100
recent_metrics_cache = LRUCache(maxsize=RECENT_METRICS_CACHE_SIZE)

# In‑memory store for historical metrics (list of Metric)
historical_metrics: List["Metric"] = []

# -------------------- JWT Utilities --------------------
def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> dict:
    try:
        payload = jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Token has expired"
        )
    except jwt.InvalidTokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token"
        )


security = HTTPBearer()


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> dict:
    token = credentials.credentials
    payload = decode_access_token(token)
    return payload


# -------------------- Pydantic Models --------------------
class ScorePayload(BaseModel):
    scores: List[float] = Field(..., description="List of anomaly scores")

    @validator("scores")
    def non_empty(cls, v):
        if not v:
            raise ValueError("scores list must not be empty")
        return v


class Metric(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    smoothed_score: float
    drift: float


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"


class MetricsResponse(BaseModel):
    metrics: List[Metric]


# -------------------- Kalman Filter --------------------
class KalmanFilter1D:
    """
    Simple 1‑D Kalman filter.
    State equation:   x_k = x_{k-1}
    Measurement eq.:  z_k = x_k + v_k,   v_k ~ N(0, R)

    Process variance (Q) models the uncertainty in the system dynamics.
    Measurement variance (R) models the sensor noise.
    """

    def __init__(self, process_variance: float = 1e-5, measurement_variance: float = 1e-2):
        self.q = process_variance
        self.r = measurement_variance
        self.x = 0.0  # initial estimate
        self.p = 1.0  # initial error covariance
        self.initialized = False

    def update(self, measurement: float) -> float:
        if not self.initialized:
            self.x = measurement
            self.initialized = True

        # Prediction step
        # x_prior = x (no control input)
        p_prior = self.p + self.q

        # Update step
        k_gain = p_prior / (p_prior + self.r)  # Kalman gain
        self.x = self.x + k_gain * (measurement - self.x)
        self.p = (1 - k_gain) * p_prior

        return self.x


# -------------------- KL Divergence --------------------
def kl_divergence(p: np.ndarray, q: np.ndarray) -> float:
    """
    Compute KL divergence D_KL(P || Q) for discrete distributions.
    Formula: D_KL(P||Q) = Σ_i P(i) * log(P(i) / Q(i))
    Both p and q must be probability vectors (sum to 1) and have same length.
    """
    epsilon = 1e-10
    p = np.clip(p, epsilon, 1)
    q = np.clip(q, epsilon, 1)
    return float(np.sum(p * np.log(p / q)))


def compute_drift(
    baseline_scores: List[float], current_scores: List[float], bins: int = 20
) -> float:
    """
    Compute drift between baseline and current score distributions using KL divergence.
    """
    if not baseline_scores or not current_scores:
        return 0.0

    hist_base, _ = np.histogram(baseline_scores, bins=bins, range=(0.0, 1.0), density=True)
    hist_curr, _ = np.histogram(current_scores, bins=bins, range=(0.0, 1.0), density=True)

    # Normalize to get probability distributions
    p = hist_base / np.sum(hist_base)
    q = hist_curr / np.sum(hist_curr)

    return kl_divergence(p, q)


# -------------------- Background Processing --------------------
def process_scores(
    scores: List[float],
    baseline_window: int = 100,
) -> Metric:
    """
    Smooth incoming scores with a Kalman filter, compute drift against recent baseline,
    and store the resulting metric.
    """
    # Initialize Kalman filter
    kf = KalmanFilter1D()

    # Smooth scores
    smoothed = [kf.update(s) for s in scores]
    smoothed_score = float(np.mean(smoothed))

    # Determine baseline scores from recent metrics
    baseline_scores = [
        m.smoothed_score for m in list(recent_metrics_cache.values())[-baseline_window:]
    ]
    if not baseline_scores:
        baseline_scores = smoothed  # fallback to current if no history

    drift = compute_drift(baseline_scores, smoothed)

    metric = Metric(smoothed_score=smoothed_score, drift=drift)

    # Store metric in caches
    recent_metrics_cache[metric.id] = metric
    historical_metrics.append(metric)

    # Trim historical list to keep memory bounded (optional)
    max_history = 10_000
    if len(historical_metrics) > max_history:
        del historical_metrics[: len(historical_metrics) - max_history]

    return metric


# -------------------- FastAPI Application --------------------
app = FastAPI(title="Anomaly Correlation Monitoring Service")


# -------------------- Authentication Endpoints --------------------
@app.post("/token", response_model=TokenResponse, tags=["auth"])
def login(form_data: Request):
    """
    Dummy login endpoint that issues a JWT.
    In a real system, validate user credentials.
    """
    # For demonstration, we accept any request and issue a token