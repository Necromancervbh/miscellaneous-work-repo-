import os
import json
import logging
from datetime import datetime
from typing import List, Dict, Any, Optional, Set

import httpx
import numpy as np
from fastapi import (
    FastAPI,
    WebSocket,
    WebSocketDisconnect,
    Depends,
    HTTPException,
    status,
    Query,
    Body,
)
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, validator
from sklearn.decomposition import PCA

# --------------------------------------------------------------------------- #
# Configuration & Logging
# --------------------------------------------------------------------------- #
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("dashboard_service")

AGGREGATOR_URL = os.getenv("AGGREGATOR_URL", "http://localhost:8001")
MONITOR_URL = os.getenv("MONITOR_URL", "http://localhost:8002")
EXPLAINER_URL = os.getenv("EXPLAINER_URL", "http://localhost:8003")

# --------------------------------------------------------------------------- #
# FastAPI Application
# --------------------------------------------------------------------------- #
app = FastAPI(
    title="Anomaly Correlation Dashboard Service",
    description="Provides aggregated anomaly scores, PCA dimensionality reduction, and real‑time chart streaming.",
    version="1.0.0",
)

# Allow CORS for front‑end React application
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Adjust in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --------------------------------------------------------------------------- #
# Pydantic Models
# --------------------------------------------------------------------------- #
class AggregatedScoreResponse(BaseModel):
    timestamp: datetime
    score: float


class PCARequest(BaseModel):
    data: List[List[float]] = Field(..., description="2‑D array of feature vectors")
    n_components: Optional[int] = Field(
        None, ge=1, description="Number of principal components to retain"
    )

    @validator("data")
    def validate_matrix(cls, v: List[List[float]]) -> List[List[float]]:
        if not v:
            raise ValueError("`data` must contain at least one row")
        row_len = len(v[0])
        if row_len == 0:
            raise ValueError("`data` rows must contain at least one column")
        for row in v:
            if len(row) != row_len:
                raise ValueError("All rows in `data` must have the same length")
        return v


class PCAResponse(BaseModel):
    transformed: List[List[float]]
    explained_variance_ratio: List[float]


# --------------------------------------------------------------------------- #
# WebSocket Connection Manager
# --------------------------------------------------------------------------- #
class ConnectionManager:
    """Manages active WebSocket connections and broadcasting."""

    def __init__(self) -> None:
        self.active_connections: Set[WebSocket] = set()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.active_connections.add(websocket)
        logger.info(f"WebSocket connected: {websocket.client}")

    def disconnect(self, websocket: WebSocket) -> None:
        self.active_connections.discard(websocket)
        logger.info(f"WebSocket disconnected: {websocket.client}")

    async def send_personal_message(self, message: str, websocket: WebSocket) -> None:
        await websocket.send_text(message)

    async def broadcast(self, message: str) -> None:
        dead_connections: List[WebSocket] = []
        for connection in self.active_connections:
            try:
                await connection.send_text(message)
            except Exception as exc:
                logger.error(f"Error sending to {connection.client}: {exc}")
                dead_connections.append(connection)
        for dc in dead_connections:
            self.disconnect(dc)


manager = ConnectionManager()


# --------------------------------------------------------------------------- #
# Helper Functions
# --------------------------------------------------------------------------- #
async def fetch_aggregated_scores(
    start: datetime, end: datetime
) -> List[AggregatedScoreResponse]:
    """Calls the external aggregator service to retrieve anomaly scores.

    The aggregator service is expected to expose:
        GET /scores?start=ISO8601&end=ISO8601
    Returns a list of timestamps with associated scores.
    """
    url = f"{AGGREGATOR_URL}/scores"
    params = {"start": start.isoformat(), "end": end.isoformat()}
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            response = await client.get(url, params=params)
            response.raise_for