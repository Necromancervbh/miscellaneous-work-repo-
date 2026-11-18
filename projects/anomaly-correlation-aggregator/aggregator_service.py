import os
import logging
import datetime
from typing import List, Dict, Tuple, Optional

import httpx
from fastapi import FastAPI, Query, HTTPException, Depends
from pydantic import BaseModel, Field, validator

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

MONITOR_API_URL = os.getenv("MONITOR_API_URL", "http://localhost:8001/monitor")
RECOMMENDER_API_URL = os.getenv(
    "RECOMMENDER_API_URL", "http://localhost:8002/recommender"
)

# Default Kalman filter parameters (tuned for typical anomaly score variance)
DEFAULT_PROCESS_VARIANCE = float(os.getenv("KF_PROCESS_VARIANCE", "1e-5"))
DEFAULT_MEASUREMENT_VARIANCE = float(os.getenv("KF_MEASUREMENT_VARIANCE", "1e-2"))

# --------------------------------------------------------------------------- #
# Logging
# --------------------------------------------------------------------------- #

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("aggregator_service")

# --------------------------------------------------------------------------- #
# Pydantic models
# --------------------------------------------------------------------------- #


class InsightItem(BaseModel):
    timestamp: datetime.datetime = Field(..., description="Timestamp of the observation")
    monitor_score: float = Field(..., description="Anomaly score from monitor API")
    recommender_score: float = Field(..., description="Anomaly score from recommender API")
    combined_score: float = Field(..., description="Weighted combination of the two scores")
    smoothed_score: float = Field(..., description="Kalman‑filtered combined score")


class InsightsResponse(BaseModel):
    insights: List[InsightItem] = Field(..., description="List of merged insights")


# --------------------------------------------------------------------------- #
# Kalman filter implementation
# --------------------------------------------------------------------------- #


class KalmanFilter1D:
    """
    Simple 1‑dimensional Kalman filter.

    The filter equations are:
        # Predict
        x̂ₖ⁻ = x̂ₖ₋₁
        Pₖ⁻ = Pₖ₋₁ + Q

        # Update
        Kₖ = Pₖ⁻ / (Pₖ⁻ + R)
        x̂ₖ = x̂ₖ⁻ + Kₖ (zₖ - x̂ₖ⁻)
        Pₖ = (1 - Kₖ) Pₖ⁻

    where:
        Q – process variance (model uncertainty)
        R – measurement variance (sensor noise)
        x̂ – estimated state
        P – error covariance
        K – Kalman gain
        z – measurement
    """

    def __init__(
        self,
        process_variance: float = DEFAULT_PROCESS_VARIANCE,
        measurement_variance: float = DEFAULT_MEASUREMENT_VARIANCE,
        initial_estimate: float = 0.0,
        initial_error_covariance: float = 1.0,
    ):
        if process_variance <= 0 or measurement_variance <= 0:
            raise ValueError("Variances must be positive numbers")
        self.Q = process_variance
        self.R = measurement_variance
        self.x_hat = initial_estimate
        self.P = initial_error_covariance

    def filter(self, measurement: float) -> float:
        # Predict
        x_pred = self.x_hat
        P_pred = self.P + self.Q

        # Update
        K = P_pred / (P_pred + self.R)
        self.x_hat = x_pred + K * (measurement - x_pred)
        self.P = (1 - K) * P_pred
        return self.x_hat


# --------------------------------------------------------------------------- #
# Helper functions
# --------------------------------------------------------------------------- #


async def fetch_time_series(
    client: httpx.AsyncClient, url: str, start: datetime.datetime, end: datetime.datetime
) -> List[Dict[str, float]]:
    """
    Fetches a time‑series from a remote API.

    Expected response format:
        [
            {"timestamp": "2023-01-01T00:00:00Z", "score": 0.12},
            ...
        ]
    """
    params = {
        "start": start.isoformat(),
        "end": end.isoformat(),
    }
    try:
        resp = await client.get(url, params=params, timeout=10.0)
        resp.raise_for_status()
        data = resp.json()
        if not isinstance(data, list):
            raise ValueError("Response JSON is not a list")
        # Validate each entry
        cleaned = []
        for entry in data:
            if not isinstance(entry, dict):
                continue
            ts = entry.get("timestamp")
            score = entry.get("score")
            if not isinstance(ts, str) or not isinstance(score, (int, float)):
                continue
            try:
                timestamp = datetime.datetime.fromisoformat(ts.rstrip("Z"))
            except Exception:
                continue
            cleaned.append({"timestamp": timestamp, "score": float(score)})
        return cleaned
    except (httpx.HTTPError, ValueError) as exc:
        logger.error(f"Failed to fetch data from {url}: {exc}")
        raise HTTPException(
            status_code=502,
            detail=f"Unable to retrieve data from upstream service at {url}",
        ) from exc


def align_series(
    monitor: List[Dict[str, float]], recommender: List[Dict[str, float]]
) -> List[Tuple[datetime.datetime, float, float]]:
    """
    Align two series on their timestamps using an inner join.

    Returns a list of tuples:
        (timestamp, monitor_score, recommender_score)
    """
    monitor_map = {item["timestamp"]: item["score"] for item in monitor}
    recommender_map = {item["timestamp"]: item["score"] for item in recommender}
    common_ts = sorted(set(monitor_map.keys()) & set(recommender_map.keys()))
    aligned = [
        (ts, monitor_map[ts], recommender_map[ts]) for ts in common_ts
    ]  # type: ignore
    return aligned


def compute_weighted_combination(
    aligned: List[Tuple[datetime.datetime, float, float]],
    monitor_weight: float,
    recommender_weight: float,
) -> List[Tuple[datetime.datetime, float, float, float]]:
    """
    Apply weights to the two scores and compute a combined score.

    Returns a list of tuples:
        (timestamp, monitor_score, recommender_score, combined_score)
    """
    total = monitor_weight + recommender_weight
    if total == 0:
        raise ValueError("Sum of weights must be greater than zero")
    w1 = monitor_weight / total
    w2 = recommender_weight / total
    combined = [
        (
            ts,
            m_score,
            r_score,
            w1 * m_score + w2 *