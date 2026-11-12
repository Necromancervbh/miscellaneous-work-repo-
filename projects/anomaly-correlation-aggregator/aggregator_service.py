import os
import logging
from datetime import datetime, timedelta
from typing import List, Dict, Any, Optional

from fastapi import FastAPI, Depends, HTTPException, status, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, Field, validator
from sklearn.cluster import DBSCAN
from sklearn.preprocessing import StandardScaler
from cachetools import LRUCache
from jose import JWTError, jwt

# -------------------- Configuration --------------------
JWT_SECRET_KEY: str = os.getenv("JWT_SECRET_KEY", "supersecretkey")
JWT_ALGORITHM: str = "HS256"
JWT_ACCESS_TOKEN_EXPIRE_MINUTES: int = 60

DBSCAN_EPS: float = 0.5  # Neighborhood radius
DBSCAN_MIN_SAMPLES: int = 5  # Minimum points to form a cluster

# -------------------- Logging --------------------
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("aggregator_service")

# -------------------- FastAPI App --------------------
app = FastAPI(title="Anomaly Correlation Aggregator")

# -------------------- Security --------------------
bearer_scheme = HTTPBearer(auto_error=False)


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """
    Create a JWT token.
    """
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=JWT_ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, JWT_SECRET_KEY, algorithm=JWT_ALGORITHM)
    return encoded_jwt


def verify_token(credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme)) -> dict:
    """
    Verify JWT token and return payload.
    """
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = credentials.credentials
    try:
        payload = jwt.decode(token, JWT_SECRET_KEY, algorithms=[JWT_ALGORITHM])
        return payload
    except JWTError as e:
        logger.warning(f"JWT verification failed: {e}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
            headers={"WWW-Authenticate": "Bearer"},
        )


# -------------------- Data Models --------------------
class AnomalyEvent(BaseModel):
    """
    Model representing an anomaly event emitted by the forecasting service.
    """
    id: str = Field(..., description="Unique identifier of the anomaly")
    timestamp: datetime = Field(..., description="Timestamp of the anomaly detection")
    shap_values: List[float] = Field(..., description="SHAP feature vector for the anomaly")

    @validator("shap_values")
    def shap_non_empty(cls, v):
        if not v:
            raise ValueError("shap_values must contain at least one element")
        return v


class ClusterResponse(BaseModel):
    """
    Response model for clustered anomaly groups.
    """
    clusters: Dict[int, List[str]] = Field(..., description="Mapping from cluster label to list of anomaly IDs")
    generated_at: datetime = Field(..., description="Timestamp when the clustering result was generated")


# -------------------- In-Memory Storage --------------------
# Store raw anomaly vectors and their IDs
_anomaly_store: List[Dict[str, Any]] = []

# LRU cache to keep the latest clustering result (maxsize=1)
_cluster_cache: LRUCache = LRUCache(maxsize=1)


# -------------------- Core Logic --------------------
def _run_dbscan_clustering(vectors: List[List[float]]) -> List[int]:
    """
    Run DBSCAN clustering on the provided vectors.
    Returns a list of cluster labels aligned with input order.
    """
    if not vectors:
        return []

    # Standardize features: (x - μ) / σ
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(vectors)

    # DBSCAN algorithm
    dbscan = DBSCAN(eps=DBSCAN_EPS, min_samples=DBSCAN_MIN_SAMPLES)
    labels = dbscan.fit_predict(X_scaled)
    return labels.tolist()


def _update_clusters() -> None:
    """
    Recompute clustering on the stored anomaly vectors and update the LRU cache.
    """
    if not _anomaly_store:
        _cluster_cache.clear()
        return

    vectors = [item["shap_values"] for item in _anomaly_store]
    ids = [item["id"] for item in _anomaly_store]

    labels = _run_dbscan_clustering(vectors)

    cluster_map: Dict[int, List[str]] = {}
    for anomaly_id, label in zip(ids, labels):
        cluster_map.setdefault(label, []).append(anomaly_id)

    # Store result with timestamp
    result = {
        "clusters": cluster_map,
        "generated_at": datetime.utcnow(),
    }
    _cluster_cache["latest"] = result
    logger.info(f"Clustering updated: {len(cluster_map)} clusters")


# -------------------- API Endpoints --------------------
@app.post("/anomaly", status_code=status.HTTP_202_ACCEPTED, tags=["Events"])
async def receive_anomaly(event: AnomalyEvent, request: Request) -> Dict[str, str]:
    """
    Endpoint to receive anomaly events (simulating subscription).
    The payload must contain a SHAP feature vector.
    """
    # Basic validation already performed by Pydantic
    _anomaly_store.append(event.dict())
    logger.debug(f"Received anomaly event: {event.id}")

    # Update clustering asynchronously to avoid blocking the request
    try:
        _update_clusters()
    except Exception as exc:
        logger.exception(f"Failed to update clusters: {exc}")
        raise HTTPException(status_code=500, detail="Clustering error")

    return {"detail": "Anomaly received and processed"}


@app.get("/clusters", response_model=ClusterResponse, tags=["Analytics"])
async def get_clusters(payload: dict = Depends(verify_token)) -> ClusterResponse:
    """
    JWT-protected endpoint returning the latest clustered anomaly groups.
    """
    cached = _cluster_cache.get("latest")
    if not cached:
        # No data available yet
        return ClusterResponse(clusters={}, generated_at=datetime.utcnow())

    return ClusterResponse(
        clusters=cached["clusters"],
        generated_at=cached["generated_at"]
    )