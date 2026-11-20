import asyncio
import logging
import time
from datetime import datetime, timedelta
from typing import List, Set, Dict, Any

import jwt
from cachetools import LRUCache
from fastapi import (
    FastAPI,
    Depends,
    HTTPException,
    status,
    WebSocket,
    WebSocketDisconnect,
    Request,
)
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from pydantic import BaseModel, Field, ValidationError

# ------------------------------- Configuration -------------------------------

SECRET_KEY = "your-very-secret-key"  # In production, load from env
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60

# Rate limiting: max messages per client per second
RATE_LIMIT_PER_SECOND = 5

# LRU cache size for recent alerts
ALERT_CACHE_MAXSIZE = 1000

# ------------------------------- Logging ------------------------------------

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("notifier_service")

# ------------------------------- Models -------------------------------------

class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class TokenData(BaseModel):
    username: str | None = None
    exp: int | None = None


class User(BaseModel):
    username: str
    full_name: str | None = None
    disabled: bool = False


class UserInDB(User):
    hashed_password: str


class Alert(BaseModel):
    id: str = Field(..., description="Unique identifier for the alert")
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    severity: str = Field(..., regex="^(low|medium|high|critical)$")
    message: str = Field(..., max_length=1024)


# ------------------------------- In‑Memory Store -----------------------------

# Demo user store; replace with real DB in production
_fake_users_db: Dict[str, UserInDB] = {
    "alice": UserInDB(
        username="alice",
        full_name="Alice Example",
        hashed_password="fakehashedpassword",  # Not used; placeholder
        disabled=False,
    )
}


def fake_hash_password(password: str) -> str:
    """Simple hash placeholder; replace with bcrypt/scrypt in prod."""
    return "fakehashed" + password


def authenticate_user(username: str, password: str) -> UserInDB | None:
    user = _fake_users_db.get(username)
    if not user:
        return None
    if user.hashed_password != fake_hash_password(password):
        return None
    return user


def create_access_token(data: dict, expires_delta: timedelta | None = None) -> str:
    """Create a JWT token.
    Formula: token = base64url_encode(header) + "." + base64url_encode(payload) + "." + signature
    """
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt


def decode_token(token: str) -> TokenData:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return TokenData(**payload)
    except (jwt.PyJWTError, ValidationError) as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        ) from e


oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/token")

async def get_current_user(token: str = Depends(oauth2_scheme)) -> User:
    token_data = decode_token(token)
    if token_data.username is None:
        raise HTTPException(status_code=401, detail="Invalid token payload")
    user = _fake_users_db.get(token_data.username)
    if user is None or user.disabled:
        raise HTTPException(status_code=401, detail="User not found or disabled")
    return user


# ------------------------------- FastAPI App -------------------------------

app = FastAPI(title="Anomaly Correlation Notifier Service")

# ------------------------------- Rate Limiter ------------------------------

class RateLimiter:
    """Token bucket rate limiter per client."""
    def __init__(self, rate: int):
        self.rate = rate
        self.allowance: Dict[str, float] = {}
        self.last_check: Dict[str, float] = {}

    def is_allowed(self, client_id: str) -> bool:
        current = time.time()
        allowance = self.allowance.get(client_id, self.rate)
        last_check = self.last_check.get(client_id, current)
        # Refill tokens based on elapsed time
        elapsed = current - last_check
        allowance = min(self.rate, allowance + elapsed * self.rate)
        if allowance < 1.0:
            # Not enough tokens
            self.allowance[client_id] = allowance
            self.last_check[client_id] = current
            return False
        else:
            # Consume a token
            self.allowance[client_id] = allowance - 1.0
            self.last_check[client_id] = current
            return True


rate_limiter = RateLimiter(RATE_LIMIT_PER_SECOND)

# ------------------------------- WebSocket Management -----------------------

class ConnectionManager:
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
                logger.error(f"Error sending to client {connection.client}: {exc}")

manager = ConnectionManager()

# ------------------------------- Alert Queue & Cache -----------------------

alerts_queue: asyncio.Queue[Alert] = asyncio.Queue()
alert_cache = LRUCache(maxsize=ALERT_CACHE_MAXSIZE)

async def alert_worker():
    """Background task that processes alerts from the queue."""
    while True:
        alert: Alert = await alerts_queue.get()
        # Store in LRU cache
        alert_cache[alert.id] = alert
        # Broadcast to all connected WebSocket clients
        await manager.broadcast(alert.json())
        alerts_queue.task_done()
        logger.info(f"Processed alert {alert.id}")

# ------------------------------- API Endpoints ------------------------------

@app.post("/token", response_model=Token, summary="Obtain JWT token")
async def login(form_data: OAuth2PasswordRequestForm = Depends()):
    user = authenticate_user(form_data.username, form_data.password)
    if not user:
        raise HTTPException(status_code=400, detail="Incorrect username or password")
    access_token = create_access_token(data={"username": user.username})
    return Token(access_token=access_token)


@app.post("/alerts", status_code=202, summary="Submit a new anomaly alert")
async def submit_alert(alert: Alert, current_user: User = Depends(get_current_user)):
    """
    Validates and enqueues an