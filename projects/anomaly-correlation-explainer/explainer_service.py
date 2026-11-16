import os
import logging
from typing import List, Tuple, Dict, Any
from functools import lru_cache

import jwt
from fastapi import FastAPI, Depends, HTTPException, status, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, validator
from starlette.responses import JSONResponse

# Rate limiting
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# JWT configuration
JWT_SECRET = os.getenv("JWT_SECRET", "your-secret-key")
JWT_ALGORITHM = "HS256"

# FastAPI app initialization
app = FastAPI(title="Anomaly Correlation Explainer", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Adjust in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Rate limiter (5 requests per minute per IP)
limiter = Limiter(key_func=get_remote_address, default_limits=["5/minute"])
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Security scheme
bearer_scheme = HTTPBearer(auto_error=False)


def decode_jwt(token: str) -> Dict[str, Any]:
    """
    Decode a JWT token using the configured secret and algorithm.
    Raises HTTPException if token is invalid or expired.
    """
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token has expired",
        )
    except jwt.InvalidTokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
        )


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
) -> Dict[str, Any]:
    """
    FastAPI dependency that extracts and validates JWT token.
    Returns the token payload if valid.
    """
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication scheme",
        )
    token = credentials.credentials
    return decode_jwt(token)


class SeriesRequest(BaseModel):
    """
    Request model containing a list of series identifiers.
    """
    series_ids: List[int] = Field(..., description="List of series IDs to explain")

    @validator("series_ids")
    def ids_must_be_unique_and_nonempty(cls, v):
        if not v:
            raise ValueError("series_ids must contain at least one ID")
        if len(set(v)) != len(v):
            raise ValueError("series_ids must contain unique IDs")
        return v


class Explanation(BaseModel):
    """
    Single explanation entry with series ID and its causal contribution probability.
    """
    series_id: int = Field(..., description="Series identifier")
    contribution: float = Field(..., ge=0.0, le=1.0, description="Causal contribution probability")


class ExplanationResponse(BaseModel):
    """
    Response model containing a ranked list of explanations.
    """
    explanations: List[Explanation] = Field(..., description="Ranked explanations")


def _hash_based_probability(series_id: int) -> float:
    """
    Deterministic pseudo-probability based on series_id.
    Formula: (hash(series_id) % 1000) / 1000
    Guarantees reproducibility across calls.
    """
    # Using built‑in hash may vary per process; use a stable hash function instead.
    stable_hash = (series_id * 31 + 7) % 1000  # Simple linear congruential hash
    return stable_hash / 1000.0


@lru_cache(maxsize=128)
def compute_contributions_cached(series_ids_key: Tuple[int, ...]) -> List[Tuple[int, float]]:
    """
    Compute causal contribution probabilities for a tuple of series IDs.
    Results are cached using an LRU strategy.

    Parameters
    ----------
    series_ids_key : Tuple[int, ...]
        Immutable tuple of series IDs.

    Returns
    -------
    List[Tuple[int, float]]
        List of (series_id, probability) sorted descending by probability.
    """
    # Placeholder Bayesian network computation.
    # In a real implementation, this would involve constructing the network,
    # performing inference, and extracting marginal probabilities.
    contributions = []
    for sid in series_ids_key:
        prob = _hash_based_probability(sid)
        contributions.append((sid, prob))

    # Sort by probability descending (higher contribution first)
    contributions.sort(key=lambda x: x[1], reverse=True)
    return contributions


@app.post(
    "/explain",
    response_model=ExplanationResponse,
    dependencies=[Depends(limiter.limit("5/minute")), Depends(get_current_user)],
    summary="Compute causal contributions for given series IDs",
    tags=["Explanation"],
)
async def explain_series(request: SeriesRequest) -> JSONResponse:
    """
    Endpoint that accepts a list of series IDs, runs a Bayesian network
    (simulated here), caches results, and returns a ranked list of
    explanations with contribution probabilities.
    """
    try:
        # Convert mutable list to immutable tuple for caching
        series_ids_key = tuple(sorted(request.series_ids))
        raw_contributions = compute_contributions_cached(series_ids_key)

        explanations = [
            Explanation(series_id=sid, contribution=prob) for sid, prob in raw_contributions
        ]

        response = ExplanationResponse(explanations=explanations)
        return JSONResponse(status_code=status.HTTP_200_OK, content=response.dict())
    except Exception as exc:
        logger.exception("Unexpected error while processing explanation request")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Internal server error",
        ) from exc


# Health check endpoint
@app.get("/health", tags=["Health"])
async def health_check() -> Dict[str, str]:
    """
    Simple health check endpoint.
    """
    return {"status": "ok"}