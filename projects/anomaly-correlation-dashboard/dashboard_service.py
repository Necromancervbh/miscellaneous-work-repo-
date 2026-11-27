import os
import time
import json
import logging
import asyncio
from typing import List, Dict, Any, Set, Optional

import numpy as np
from fastapi import (
    FastAPI,
    WebSocket,
    WebSocketDisconnect,
    Depends,
    HTTPException,
    status,
    Request,
    BackgroundTasks,
)
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ValidationError, validator
from jose import JWTError, jwt
from sklearn.decomposition import PCA
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address

# -------------------------------------------------------------------------
# Configuration and Logging
# -------------------------------------------------------------------------

SECRET_KEY = os.getenv("JWT_SECRET_KEY", "supersecretkey")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_SECONDS = 3600  # 1 hour

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("dashboard_service")

# -------------------------------------------------------------------------
# JWT Utility Functions
# -------------------------------------------------------------------------

def create_access_token(data: dict, expires_delta: Optional[int] = None) -> str:
    """
    Create a JWT token.
    :param data: Payload data.
    :param expires_delta: Expiration time in seconds.
    :return: Encoded JWT string.
    """
    to_encode = data.copy()
    expire = int(time.time()) + (expires_delta or ACCESS_TOKEN_EXPIRE_SECONDS)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt

def decode_access_token(token: str) -> dict:
    """
    Decode and verify a JWT token.
    :param token: JWT string.
    :return: Decoded payload.
    :raises HTTPException: If token is invalid or expired.
    """
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload
    except JWTError as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
        ) from e

# -------------------------------------------------------------------------
# Pydantic Models
# -------------------------------------------------------------------------

class UserLogin(BaseModel):
    username: str = Field(..., min_length=3, max_length=50)
    password: str = Field(..., min_length=3, max_length=128)

class AnomalyRecord(BaseModel):
    timestamp: int = Field(..., description="Unix epoch time in seconds")
    score: float = Field(..., ge=0.0, le=1.0, description="Anomaly score between 0 and 1")
    features: List[float] = Field(..., min_items=1, description="Feature vector")

    @validator("timestamp")
    def timestamp_must_be_recent(cls, v):
        if v > int(time.time()) + 60:
            raise ValueError("timestamp cannot be in the future")
        return v

class BroadcastMessage(BaseModel):
    aggregated_score: float = Field(..., description="Mean anomaly score")
    pca_components: List[List[float]] = Field(..., description="2D PCA reduced vectors")

# -------------------------------------------------------------------------
# In-Memory User Store (Demo Purposes)
# -------------------------------------------------------------------------

# In a real application, replace with persistent user DB and hashed passwords.
_USERS_DB = {
    "alice": {"username": "alice", "password": "wonderland"},
    "bob": {"username": "bob", "password": "builder"},
}

def authenticate_user(username: str, password: str) -> bool:
    user = _USERS_DB.get(username)
    if not user:
        return False
    return user["password"] == password

# -------------------------------------------------------------------------
# FastAPI Application Setup
# -------------------------------------------------------------------------

app = FastAPI(title="Anomaly Correlation Dashboard Service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Adjust for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Rate Limiter (100 requests per minute per IP)
limiter = Limiter(key_func=get_remote_address, default_limits=["100/minute"])
app.state.limiter = limiter
app.add_exception_handler(429, _rate_limit_exceeded_handler)

# -------------------------------------------------------------------------
# Security Dependencies
# -------------------------------------------------------------------------

bearer_scheme = HTTPBearer(auto_error=False)

async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
) -> str:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing authentication token",
        )
    token = credentials.credentials
    payload = decode_access_token(token)
    username: str = payload.get("sub")
    if username is None or username not in _USERS_DB:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication credentials",
        )
    return username

# -------------------------------------------------------------------------
# Shared State for Aggregation and Broadcasting
# -------------------------------------------------------------------------

class Aggregator:
    """
    Thread‑safe aggregator for anomaly scores and feature vectors.
    """
    def __init__(self, max_window: int = 500):
        self._scores: List[float] = []
        self._features: List[List[float]] = []
        self._max_window = max_window
        self._lock = asyncio.Lock()
        self._pca = PCA(n_components=2)

    async def add_record(self, record: AnomalyRecord) -> BroadcastMessage:
        async with self._lock:
            # Append new data
            self._scores.append(record.score)
            self._features.append(record.features)

            # Trim window
            if len(self._scores) > self._max_window:
                self._scores = self._scores[-self._max_window :]
                self._features = self._features[-self._max_window :]

            # Compute aggregated score (mean)
            aggregated_score = float(np.mean(self._scores))

            # Compute PCA on feature matrix
            feature_matrix = np.array(self._features)
            # Ensure we have enough samples for PCA
            if feature_matrix.shape[0] >= 2: