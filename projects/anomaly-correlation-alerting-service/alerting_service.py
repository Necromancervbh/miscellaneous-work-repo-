import os
import asyncio
import json
import logging
import time
from datetime import datetime, timedelta
from typing import Dict, Set, Any, Callable, Awaitable

import httpx
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Depends, HTTPException, status, Request
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from jose import JWTError, jwt
from pydantic import BaseModel, ValidationError, Field

# ----------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------
ORCHESTRATOR_STREAM_URL = os.getenv("ORCHESTRATOR_STREAM_URL", "http://localhost:8001/events")
JWT_SECRET = os.getenv("JWT_SECRET", "supersecret")
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
RATE_LIMIT_MAX_REQUESTS = int(os.getenv("RATE_LIMIT_MAX_REQUESTS", "10"))
RATE_LIMIT_WINDOW_SECONDS = int(os.getenv("RATE_LIMIT_WINDOW_SECONDS", "60"))

# ----------------------------------------------------------------------
# Logging
# ----------------------------------------------------------------------
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("alerting_service")

# ----------------------------------------------------------------------
# Pydantic models
# ----------------------------------------------------------------------
class OrchestratorEvent(BaseModel):
    """
    Model representing an event received from the orchestrator.
    """
    event_id: str = Field(..., description="Unique identifier for the event")
    timestamp: datetime = Field(..., description="Event timestamp")
    payload: Dict[str, Any] = Field(..., description="Event payload")
    token: str = Field(..., description="JWT token for authentication")

class AlertMessage(BaseModel):
    """
    Model representing an anomaly alert to be broadcasted.
    """
    alert_id: str = Field(..., description="Unique identifier for the alert")
    generated_at: datetime = Field(..., description="Alert generation time")
    severity: str = Field(..., description="Severity level (e.g., low, medium, high)")
    description: str = Field(..., description="Human readable description")
    details: Dict[str, Any] = Field(..., description="Additional alert details")

# ----------------------------------------------------------------------
# JWT validation
# ----------------------------------------------------------------------
def validate_jwt(token: str) -> Dict[str, Any]:
    """
    Validates a JWT token and returns its payload.

    Formula:
        token_payload = decode(token, secret, algorithms=[algorithm])
    """
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return payload
    except JWTError as exc:
        logger.warning(f"JWT validation failed: {exc}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication token",
        ) from exc

# ----------------------------------------------------------------------
# Rate Limiter (Token Bucket)
# ----------------------------------------------------------------------
class RateLimiter:
    """
    Simple in-memory token bucket rate limiter.

    For each key (e.g., client IP), we keep a bucket with:
        tokens = max_requests
        last_refill = timestamp of last refill

    Refill formula:
        elapsed = now - last_refill
        tokens = min(max_requests, tokens + (elapsed / window) * max_requests)
    """
    def __init__(self, max_requests: int, window_seconds: int):
        self.max_requests = max_requests
        self.window = window_seconds
        self.buckets: Dict[str, Dict[str, Any]] = {}
        self.lock = asyncio.Lock()

    async def is_allowed(self, key: str) -> bool:
        async with self.lock:
            bucket = self.buckets.get(key)
            now = time.monotonic()
            if bucket is None:
                self.buckets[key] = {"tokens": self.max_requests - 1, "last_refill": now}
                return True

            elapsed = now - bucket["last_refill"]
            refill_rate = self.max_requests / self.window
            added_tokens = elapsed * refill_rate
            bucket["tokens"] = min(self.max_requests, bucket["tokens"] + added_tokens)
            bucket["last_refill"] = now

            if bucket["tokens"] >= 1:
                bucket["tokens"] -= 1
                return True
            else:
                return False

# ----------------------------------------------------------------------
# WebSocket Connection Manager
# ----------------------------------------------------------------------
class ConnectionManager:
    """
    Manages active WebSocket connections and broadcasts messages.
    """
    def __init__(self):
        self.active_connections: Set[WebSocket] = set()
        self.lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        async with self.lock:
            self.active_connections.add(websocket)
        logger.info(f"WebSocket client connected: {websocket.client}")

    async def disconnect(self, websocket: WebSocket):
        async with self.lock:
            self.active_connections.discard(websocket)
        logger.info(f"WebSocket client disconnected: {websocket.client}")

    async def broadcast(self, message: str):
        async with self.lock:
            websockets = list(self.active_connections)
        for connection in websockets:
            try:
                await connection.send_text(message)
            except Exception as exc:
                logger.error(f"Error sending message to {connection.client}: {exc}")
                await self.disconnect(connection)

# ----------------------------------------------------------------------
# FastAPI application
# ----------------------------------------------------------------------
app = FastAPI(
    title="Anomaly Correlation Alerting Service",
    description="Subscribes to orchestrator events, validates JWT, applies rate limiting, and broadcasts anomaly alerts via WebSocket.",
    version="1.0.0",
)

# Enable CORS for demo purposes
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

manager = ConnectionManager()
rate_limiter = RateLimiter(RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_SECONDS)

# ----------------------------------------------------------------------
# Dependency to extract client identifier for rate limiting
# ----------------------------------------------------------------------
def get_client_key(request: Request) -> str:
    """
    Returns a unique key for rate limiting. Prefer X-Forwarded-For header,
    fallback to client host.
    """
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    client_host = request.client.host if request.client else "unknown"
    return client_host

# ----------------------------------------------------------------------
# WebSocket endpoint
# ----------------------------------------------------------------------
@app.websocket("/ws/alerts")
async def websocket_endpoint(websocket: WebSocket, client_key: str = Depends(get_client_key)):
    """
    WebSocket endpoint that streams anomaly alerts to connected clients.
    Rate limiting is applied per client IP.
    """
    if not await rate_limiter.is_allowed(client_key):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        logger.warning(f"Rate limit exceeded for client {client_key}")
        return

    await manager.connect(websocket)
    try:
        while True:
            # Keep connection alive; optionally handle incoming messages
            await websocket.receive_text()
    except WebSocketDisconnect:
        await manager.disconnect(websocket)
    except Exception as exc:
        logger.error(f"Unexpected error in WebSocket connection: {exc}")
        await manager.disconnect(websocket)

# ----------------------------------------------------------------------
# Background task: Subscribe to orchestrator event stream
# ----------------------------------------------------------------------
async def orchestrator_event_listener():
    """
    Connects to the orchestrator's event stream using HTTP SSE (Server Sent Events).
    For each event:
        1. Parse JSON payload.
        2. Validate JWT.
        3. Transform into AlertMessage.
        4. Broadcast via WebSocket.
    """
    async with httpx.AsyncClient(timeout=None) as client:
        try:
            async with client.stream