import os
import time
import json
import logging
from typing import Any, Dict, Optional

import httpx
import jwt
import redis
from fastapi import FastAPI, Depends, Header, HTTPException, Request, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, Field, ValidationError
from celery import Celery
from celery.result import AsyncResult

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

class Settings:
    JWT_SECRET: str = os.getenv("JWT_SECRET", "supersecret")
    JWT_ALGORITHM: str = os.getenv("JWT_ALGORITHM", "HS256")
    REDIS_URL: str = os.getenv("REDIS_URL", "redis://localhost:6379/0")
    CELERY_BROKER_URL: str = os.getenv("CELERY_BROKER_URL", "redis://localhost:6379/1")
    CELERY_RESULT_BACKEND: str = os.getenv("CELERY_RESULT_BACKEND", "redis://localhost:6379/2")
    ML_SERVICE_URL: str = os.getenv("ML_SERVICE_URL", "http://localhost:8001")
    ENSEMBLE_SERVICE_URL: str = os.getenv("ENSEMBLE_SERVICE_URL", "http://localhost:8002")
    EXPLAIN_SERVICE_URL: str = os.getenv("EXPLAIN_SERVICE_URL", "http://localhost:8003")
    NOTIFIER_SERVICE_URL: str = os.getenv("NOTIFIER_SERVICE_URL", "http://localhost:8004")
    RATE_LIMIT_CAPACITY: int = int(os.getenv("RATE_LIMIT_CAPACITY", "10"))   # tokens
    RATE_LIMIT_REFILL_RATE: float = float(os.getenv("RATE_LIMIT_REFILL_RATE", "1"))  # tokens per second
    CACHE_TTL_SECONDS: int = int(os.getenv("CACHE_TTL_SECONDS", "300"))  # 5 minutes

settings = Settings()

# --------------------------------------------------------------------------- #
# Logging
# --------------------------------------------------------------------------- #

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("gateway")

# --------------------------------------------------------------------------- #
# External Clients
# --------------------------------------------------------------------------- #

redis_client = redis.from_url(settings.REDIS_URL, decode_responses=True)
http_client = httpx.AsyncClient()
celery_app = Celery(
    "gateway_tasks",
    broker=settings.CELERY_BROKER_URL,
    backend=settings.CELERY_RESULT_BACKEND,
)

# --------------------------------------------------------------------------- #
# JWT Authentication
# --------------------------------------------------------------------------- #

security = HTTPBearer()

def decode_jwt(token: str) -> Dict[str, Any]:
    try:
        payload = jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> Dict[str, Any]:
    token = credentials.credentials
    payload = decode_jwt(token)
    if "sub" not in payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token payload")
    return {"user_id": str(payload["sub"]), "scopes": payload.get("scopes", [])}

# --------------------------------------------------------------------------- #
# Rate Limiting (Token Bucket)
# --------------------------------------------------------------------------- #

def _rate_limit_key(user_id: str) -> str:
    return f"rl:{user_id}"

def _get_bucket_state(user_id: str) -> Dict[str, Any]:
    raw = redis_client.hgetall(_rate_limit_key(user_id))
    if not raw:
        return {"tokens": settings.RATE_LIMIT_CAPACITY, "timestamp": time.time()}
    return {
        "tokens": float(raw.get("tokens", settings.RATE_LIMIT_CAPACITY)),
        "timestamp": float(raw.get("timestamp", time.time())),
    }

def _save_bucket_state(user_id: str, tokens: float, timestamp: float) -> None:
    redis_client.hmset(_rate_limit_key(user_id), {"tokens": tokens, "timestamp": timestamp})

def enforce_rate_limit(user: Dict[str, Any]) -> None:
    user_id = user["user_id"]
    bucket = _get_bucket_state(user_id)
    now = time.time()
    elapsed = now - bucket["timestamp"]
    # Refill tokens: tokens = min(capacity, tokens + rate * elapsed)
    tokens = min(
        settings.RATE_LIMIT_CAPACITY,
        bucket["tokens"] + settings.RATE_LIMIT_REFILL_RATE * elapsed,
    )
    if tokens < 1:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Rate limit exceeded",
        )
    tokens -= 1  # consume one token
    _save_bucket_state(user_id, tokens, now)

# --------------------------------------------------------------------------- #
# Caching
# --------------------------------------------------------------------------- #

def _cache_key(user_id: str, endpoint: str, payload: Dict[str, Any]) -> str:
    payload_str = json.dumps(payload, sort_keys=True)
    return f"cache:{user_id}:{endpoint}:{payload_str}"

async def get_cached_response(key: str) -> Optional[Dict[str, Any]]:
    raw = redis_client.get(key)
    if raw:
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None
    return None

def set_cached_response(key: str, response: Dict[str, Any]) -> None:
    redis_client.setex(key, settings.CACHE_TTL_SECONDS, json.dumps(response))

# --------------------------------------------------------------------------- #
# Pydantic Models
# --------------------------------------------------------------------------- #

class PredictRequest(BaseModel):
    data: Dict[str, Any] = Field(..., description="Input features for prediction")

class PredictResponse(BaseModel):
    prediction: Any
    model: str

class ExplainRequest(BaseModel):
    data: Dict[str, Any] = Field(..., description="Input features to explain")
    method: Optional[str] = Field(None, description="Explainability method")

class ExplainResponse(BaseModel):
    explanation: Any

class NotifyRequest(BaseModel):
    user_id: str
    message: str

class TaskStatusResponse(BaseModel):
    task_id: str
    status: str
    result: Optional[Any] = None

# --------------------------------------------------------------------------- #
# Celery Tasks
# --------------------------------------------------------------------------- #

@celery_app.task(name="tasks.ensemble_predict")
def ensemble_predict_task(payload: Dict[str