import asyncio
import logging
from datetime import datetime
from typing import List, Optional

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field, validator
from statsmodels.tsa.seasonal import STL
from scipy.stats import norm

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Anomaly Correlation Monitoring Service")


# --------------------------- Pydantic Models ---------------------------

class Observation(BaseModel):
    timestamp: datetime = Field(..., description="ISO 8601 timestamp of the observation")
    score: float = Field(..., description="Anomaly score at the given timestamp")

    @validator("score")
    def score_must_be_finite(cls, v):
        if not np.isfinite(v):
            raise ValueError("score must be a finite number")
        return v


class PredictRequest(BaseModel):
    observations: List[Observation] = Field(..., description="Chronologically ordered observations")
    horizon: int = Field(
        10,
        gt=0,
        description="Number of future steps to forecast"
    )
    period: Optional[int] = Field(
        None,
        gt=1,
        description="Seasonal period (e.g., 24 for hourly data with daily seasonality). "
                    "If omitted, it will be inferred from data length."
    )
    confidence: float = Field(
        0.95,
        gt=0.0,
        lt=1.0,
        description="Confidence level for Bayesian intervals (e.g., 0.95 for 95% CI)"
    )


class ForecastPoint(BaseModel):
    timestamp: datetime
    mean: float
    lower: float
    upper: float


class PredictResponse(BaseModel):
    forecasts: List[ForecastPoint]


# --------------------------- Core Algorithms ---------------------------

def apply_kalman_filter(series: pd.Series) -> pd.Series:
    """
    Simple 1‑D Kalman filter for smoothing.
    Model:
        x_k = x_{k-1} + w_k,   w_k ~ N(0, Q)   (process noise)
        z_k = x_k + v_k,       v_k ~ N(0, R)   (measurement noise)
    """
    Q = np.var(series.diff().dropna()) * 0.01  # small process variance
    R = np.var(series - series.rolling(window=5, min_periods=1).mean()) * 0.1  # measurement variance

    if not np.isfinite(Q) or Q <= 0:
        Q = 1e-5
    if not np.isfinite(R) or R <= 0:
        R = 1e-2

    n = len(series)
    x_est = np.zeros(n)
    P = np.zeros(n)

    # Initial estimates
    x_est[0] = series.iloc[0]
    P[0] = 1.0

    for k in range(1, n):
        # Predict
        x_pred = x_est[k - 1]
        P_pred = P[k - 1] + Q

        # Update
        K = P_pred / (P_pred + R)  # Kalman gain
        z = series.iloc[k]
        x_est[k] = x_pred + K * (z - x_pred)
        P[k] = (1 - K) * P_pred

    return pd.Series(x_est, index=series.index)


def decompose_stl(series: pd.Series, period: int) -> pd.DataFrame:
    """
    Perform STL decomposition.
    Returns DataFrame with columns: trend, seasonal, resid
    """
    stl = STL(series, period=period, robust=True)
    result = stl.fit()
    df = pd.DataFrame({
        "trend": result.trend,
        "seasonal": result.seasonal,
        "resid": result.resid
    }, index=series.index)
    return df


def bayesian_forecast(
    trend: pd.Series,
    resid: pd.Series,
    last_timestamp: pd.Timestamp,
    freq: pd.Timedelta,
    horizon: int,
    confidence: float,
) -> List[ForecastPoint]:
    """
    Bayesian forecast assuming:
        y_{t+h} = trend_{t+h} + ε,   ε ~ N(0, σ²)
    σ² is estimated from residuals with a conjugate Inverse‑Gamma prior.
    Posterior predictive distribution for each horizon step is Normal with
    mean = last trend extrapolation (using last observed trend) and variance = σ².
    """
    # Estimate residual variance (σ²) using sample variance (MAP of Inverse‑Gamma with α=1, β=0)
    sigma2 = np.var(resid, ddof=1)
    if sigma2 <= 0 or not np.isfinite(sigma2):
        sigma2 = 1e-4

    # Simple extrapolation: assume trend continues with last observed slope
    # Compute slope using last two trend points
    if len(trend) >= 2:
        slope = trend.iloc[-1] - trend.iloc[-2]
    else:
        slope = 0.0

    forecasts: List[ForecastPoint] = []
    z = norm.ppf(0.5 + confidence / 2)  # two‑sided z‑score

    for step in range(1, horizon + 1):
        future_time = last_timestamp + step * freq
        mean = trend.iloc[-1] + slope * step
        lower = mean - z * np.sqrt(sigma2)
        upper = mean + z * np.sqrt(sigma2)
        forecasts.append(
            ForecastPoint(
                timestamp=future_time.to_pydatetime(),
                mean=mean,
                lower=lower,
                upper=upper,
            )
        )
    return forecasts


# --------------------------- Request Handler ---------------------------

@app.post("/predict", response_model=PredictResponse)
async def predict(request: PredictRequest):
    try:
        # Convert observations to DataFrame
        df = pd.DataFrame(
            {
                "timestamp": [obs.timestamp for obs in request.observations],
                "score": [obs.score for obs in request.observations],
            }
        )
        if df.empty:
            raise HTTPException(status_code=400, detail="No observations provided.")

        # Ensure chronological order
        df.sort_values("timestamp", inplace=True)
        df.set_index("timestamp", inplace=True)

        # Validate frequency (must be regular)
        inferred_freq = pd.infer_freq(df.index)
        if inferred_freq is None:
            # Try to compute median delta
            deltas = df.index.to_series().diff().dropna()
            median_delta = deltas.median()
            if pd.isna(median_delta) or median_delta <= pd.Timedelta(0):
                raise HTTPException(
                    status_code=400,
                    detail="Unable to infer regular frequency from timestamps.",
                )
            freq = median_delta
        else:
            freq = pd.tseries.frequencies.to_offset(inferred_freq)

        # Determine seasonal period
        period = request.period
        if period is None:
            # Guess period as number of observations per day if freq is hourly or less
            seconds_per_day = 86400
            period = max(2, int(seconds_per_day / freq.total_seconds()))
        if period <= 1:
            raise HTTPException(status_code=400, detail="Invalid seasonal period.")

        # Apply Kalman filter
        smoothed = apply_kalman