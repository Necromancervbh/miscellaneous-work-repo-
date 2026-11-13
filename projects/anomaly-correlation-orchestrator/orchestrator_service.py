import asyncio
import json
import os
import uuid
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import httpx
import jwt
import redis.asyncio as redis
from fastapi import (
    BackgroundTasks,
    Depends,
    FastAPI,
    HTTPException,
    Request,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field, ValidationError

# ----------------------------- Configuration -----------------------------

JWT_SECRET = os.getenv("JWT_SECRET", "supersecretkey")
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
JWT_EXP_DELTA_SECONDS = int(os.getenv("JWT_EXP_DELTA_SECONDS", "3600"))

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")
REDIS = redis.from_url(REDIS_URL, decode_responses=True)

# External services (replace with actual URLs)
FORECASTING_SERVICE_URL = os.getenv("FORECASTING_SERVICE_URL", "http://localhost:8001/forecast")
CLUSTERING_SERVICE_URL = os.getenv("CLUSTERING_SERVICE_URL", "http://localhost:8002/cluster")
SHAP_SERVICE_URL = os.getenv("SHAP_SERVICE_URL", "http://localhost:8003/shap")

# Rate limiting configuration
RATE_LIMIT = int(os.getenv("RATE_LIMIT", "30"))  # requests per minute per user
RATE_LIMIT_WINDOW = 60  # seconds

# ----------------------------- Models -----------------------------

class JobRequest(BaseModel):
    """Input payload for a new job."""
    data: List[float] = Field(..., description="Time‑series data points")
    metadata: Optional[Dict[str, Any]] = Field(default_factory=dict)


class JobResult(BaseModel):
    """Aggregated result from all downstream services."""
    job_id: str
    forecast: Any
    clusters: Any
    shap: Any
    completed_at: datetime


class ProgressMessage(BaseModel):
    """Message sent over WebSocket to indicate progress."""
    job_id: str
    status: str
    detail: Optional[str] = None
    progress: Optional[int] = None  # 0‑100


# ----------------------------- Security -----------------------------

security = HTTPBearer()


def create_jwt_token(user_id: str) -> str:
    """Create a signed JWT token."""
    payload = {
        "sub": user_id,
        "exp": datetime.utcnow() + timedelta(seconds=JWT_EXP_DELTA_SECONDS),
        "iat": datetime.utcnow(),
    }
    token = jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)
    return token


def decode_jwt_token(token: str) -> Dict[str, Any]:
    """Decode and verify a JWT token."""
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Token expired"
        )
    except jwt.InvalidTokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token"
        )


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(security),
) -> str:
    """Extract user identifier from JWT token."""
    token = credentials.credentials
    payload = decode_jwt_token(token)
    user_id: str = payload.get("sub")
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="User ID missing in token"
        )
    return user_id


# ----------------------------- Rate Limiting -----------------------------

async def rate_limiter(user_id: str):
    """Simple fixed‑window rate limiter using Redis."""
    key = f"rl:{user_id}"
    current = await REDIS.incr(key)
    if current == 1:
        await REDIS.expire(key, RATE_LIMIT_WINDOW)
    if current > RATE_LIMIT:
        ttl = await REDIS.ttl(key)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Rate limit exceeded. Try again in {ttl}s",
        )
    return


# ----------------------------- Job Management -----------------------------

class JobManager:
    """Manages background jobs and progress reporting."""

    def __init__(self):
        self.active_jobs: Dict[str, asyncio.Task] = {}
        self.progress_subscribers: Dict[str, List[WebSocket]] = {}
        self.lock = asyncio.Lock()

    async def submit_job(self, user_id: str, payload: JobRequest) -> str:
        job_id = str(uuid.uuid4())
        task = asyncio.create_task(self._run_job(job_id, user_id, payload))
        async with self.lock:
            self.active_jobs[job_id] = task
        return job_id

    async def _run_job(self, job_id: str, user_id: str, payload: JobRequest):
        """Orchestrates calls to downstream services, updates progress, and caches result."""
        try:
            await self._publish_progress(job_id, "started", progress=0)

            async with httpx.AsyncClient(timeout=30.0) as client:
                # 1. Forecasting
                await self._publish_progress(job_id, "forecasting", progress=10)
                forecast_resp = await client.post(
                    FORECASTING_SERVICE_URL,
                    json={"data": payload.data, "metadata": payload.metadata},
                )
                forecast_resp.raise_for_status()
                forecast = forecast_resp.json()

                # 2. Clustering
                await self._publish_progress(job_id, "clustering", progress=40)
                cluster_resp = await client.post(
                    CLUSTERING_SERVICE_URL,
                    json={"data": payload.data, "metadata": payload.metadata},
                )
                cluster_resp.raise_for_status()
                clusters = cluster_resp.json()

                # 3. SHAP insights
                await self._publish_progress(job_id, "shap", progress=70)
                shap_resp = await client.post(
                    SHAP_SERVICE_URL,
                    json={"data": payload.data, "metadata": payload.metadata},
                )
                shap_resp.raise_for_status()
                shap = shap_resp.json()

            result = JobResult(
                job_id=job_id,
                forecast=forecast,
                clusters=clusters,
                shap=shap,
                completed_at=datetime.utcnow(),
            )
            await REDIS.set(f"job:{job_id}:result", result.json())
            await self._publish_progress(job_id, "completed", progress=100, detail="Job finished")
        except httpx.HTTPError as exc:
            await self._publish_progress(
                job_id,
                "error",
                progress=100,
                detail=f"HTTP error: {str(exc)}",
            )
        except Exception as exc:
            await self._publish_progress(
                job_id,
                "error",
                progress=100,
                detail=f"Unexpected error: {str(exc)}",
            )
        finally:
            async with self.lock:
                self.active_jobs.pop(job_id, None)

    async def _publish_progress(
        self,
        job_id: str,
        status: str,
        progress: Optional[int] = None,
        detail: Optional[str] = None,
    ):
        """Store progress in Redis and push to any open WebSocket connections."""
        msg = ProgressMessage(
            job_id=job_id, status=status, progress=progress, detail=detail
        ).json()
        await REDIS.set(f"job:{job_id}:progress", msg)
        # Broadcast to WebSocket subscribers