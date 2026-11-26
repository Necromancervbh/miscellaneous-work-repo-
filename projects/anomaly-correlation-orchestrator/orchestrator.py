import os
import time
import math
import threading
from typing import List, Dict, Any, Optional

from fastapi import FastAPI, Depends, HTTPException, status, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, Field, validator
from jose import JWTError, jwt
from celery import Celery, states
from celery.result import AsyncResult
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address

# ------------------- Configuration ------------------- #

# JWT Settings
SECRET_KEY = os.getenv("JWT_SECRET_KEY", "supersecretkey")
ALGORITHM = "HS256"

# Celery Settings
CELERY_BROKER_URL = os.getenv("CELERY_BROKER_URL", "redis://localhost:6379/0")
CELERY_RESULT_BACKEND = os.getenv("CELERY_RESULT_BACKEND", "redis://localhost:6379/0")

# Rate Limiting Settings
RATE_LIMIT = os.getenv("RATE_LIMIT", "10/minute")  # default 10 requests per minute

# ------------------- Celery App ------------------- #

celery_app = Celery(
    "orchestrator_tasks",
    broker=CELERY_BROKER_URL,
    backend=CELERY_RESULT_BACKEND,
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
)


# ------------------- Helper Classes ------------------- #

class KalmanFilter:
    """
    Simple 1-D Kalman filter for smoothing scalar measurements.

    Predict step:
        x̂ₖ|ₖ₋₁ = x̂ₖ₋₁
        Pₖ|ₖ₋₁ = Pₖ₋₁ + Q

    Update step:
        Kₖ = Pₖ|ₖ₋₁ / (Pₖ|ₖ₋₁ + R)
        x̂ₖ = x̂ₖ|ₖ₋₁ + Kₖ (zₖ - x̂ₖ|ₖ₋₁)
        Pₖ = (1 - Kₖ) Pₖ|ₖ₋₁
    """
    def __init__(self, process_variance: float = 1e-5, measurement_variance: float = 1e-2):
        self.Q = process_variance      # Process (model) variance
        self.R = measurement_variance  # Measurement variance
        self.x_hat = 0.0                # Initial estimate
        self.P = 1.0                    # Initial estimate covariance
        self.initialized = False

    def update(self, measurement: float) -> float:
        if not self.initialized:
            self.x_hat = measurement
            self.initialized = True
            return self.x_hat

        # Predict
        x_pred = self.x_hat
        P_pred = self.P + self.Q

        # Update
        K = P_pred / (P_pred + self.R)
        self.x_hat = x_pred + K * (measurement - x_pred)
        self.P = (1 - K) * P_pred

        return self.x_hat


# ------------------- JWT Authentication ------------------- #

class TokenData(BaseModel):
    username: Optional[str] = None


security = HTTPBearer()


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security)
) -> TokenData:
    token = credentials.credentials
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username: str = payload.get("sub")
        if username is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token missing subject",
            )
        return TokenData(username=username)
    except JWTError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid token: {str(e)}",
        )


# ------------------- Request / Response Models ------------------- #

class TrainRequest(BaseModel):
    dataset_id: str = Field(..., min_length=1, max_length=64)
    model_type: str = Field(..., regex="^(cnn|rnn|transformer)$")


class InferenceRequest(BaseModel):
    model_id: str = Field(..., min_length=1, max_length=64)
    input_data: List[float] = Field(..., min_items=1)

    @validator("input_data")
    def check_finite(cls, v):
        if any(not math.isfinite(x) for x in v):
            raise ValueError("All input_data values must be finite numbers")
        return v


class MonitorRequest(BaseModel):
    service_name: str = Field(..., min_length=1, max_length=128)


class TaskIdsResponse(BaseModel):
    train_task_id: str
    inference_task_id: str
    monitor_task_id: str


class AggregatedResultResponse(BaseModel):
    smoothed_value: float
    raw_values: List[float]


# ------------------- Celery Tasks ------------------- #

@celery_app.task(bind=True, name="train_model")
def train_model(self, dataset_id: str, model_type: str) -> float:
    """
    Simulated training task.
    Returns a dummy training loss (float).
    """
    time.sleep(2)  # Simulate long-running training
    # Dummy loss decreasing with model complexity
    base_loss = {"cnn": 0.5, "rnn": 0.6, "transformer": 0.4}[model_type]
    loss = base_loss * (1 + 0.1 * (hash(dataset_id) % 10))
    return loss


@celery_app.task(bind=True, name="ensemble_inference")
def ensemble_inference(self, model_id: str, input_data: List[float]) -> float:
    """
    Simulated ensemble inference task.
    Returns a dummy prediction (float).
    """
    time.sleep(1)  # Simulate inference latency
    prediction = sum(input_data) / len(input_data) * (1 + 0.05 * (hash(model_id) % 5))
    return prediction


@celery_app.task(bind=True, name="monitor_service")
def monitor_service(self, service_name: str) -> float: