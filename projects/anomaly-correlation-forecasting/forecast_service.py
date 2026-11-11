import logging
from typing import List, Optional

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, validator

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Anomaly Correlation Forecasting Service")


class ForecastRequest(BaseModel):
    """
    Request model for forecasting endpoint.

    Attributes
    ----------
    observations : List[float]
        Historical time series observations.
    forecast_steps : int, optional
        Number of future steps to forecast. Defaults to 10.
    process_variance : float, optional
        Process (model) variance (q) for the Kalman filter. Defaults to 1e-5.
    observation_variance : float, optional
        Observation variance (r) for the Kalman filter. Defaults to 1e-2.
    confidence_level : float, optional
        Desired confidence level for intervals (e.g., 0.95). Defaults to 0.95.
    """
    observations: List[float] = Field(..., description="Historical time series observations")
    forecast_steps: int = Field(10, ge=1, description="Number of future steps to forecast")
    process_variance: float = Field(1e-5, gt=0.0, description="Process variance (q)")
    observation_variance: float = Field(1e-2, gt=0.0, description="Observation variance (r)")
    confidence_level: float = Field(0.95, gt=0.0, lt=1.0, description="Confidence level for intervals")

    @validator("observations")
    def check_observations(cls, v):
        if not v:
            raise ValueError("Observations list must not be empty")
        if any(not isinstance(x, (int, float)) for x in v):
            raise ValueError("All observations must be numeric")
        return v


class ForecastResponse(BaseModel):
    """
    Response model containing forecasted values and confidence intervals.
    """
    forecast: List[float] = Field(..., description="Mean forecasted values")
    lower_bound: List[float] = Field(..., description="Lower bound of confidence interval")
    upper_bound: List[float] = Field(..., description="Upper bound of confidence interval")
    confidence_level: float = Field(..., description="Confidence level used for intervals")


class KalmanFilter1D:
    """
    Simple 1‑D Kalman filter with level and trend components.

    State vector x = [level, trend]^T
    Transition model:
        x_k = F * x_{k-1} + w_k,   w_k ~ N(0, Q)
    Observation model:
        z_k = H * x_k + v_k,       v_k ~ N(0, R)

    Where:
        F = [[1, 1],
             [0, 1]]
        H = [1, 0]
        Q = q * [[1/4, 1/2],
                 [1/2, 1]]
        R = r
    """
    def __init__(self, process_variance: float, observation_variance: float):
        self.F = np.array([[1.0, 1.0],
                           [0.0, 1.0]])                     # State transition matrix
        self.H = np.array([[1.0, 0.0]])                     # Observation matrix
        q = process_variance
        self.Q = q * np.array([[0.25, 0.5],
                               [0.5, 1.0]])                # Process noise covariance
        self.R = np.array([[observation_variance]])        # Observation noise covariance

        # Initial state (level = first observation, trend = 0)
        self.x = np.zeros((2, 1))
        self.P = np.eye(2)                                 # Initial covariance

    def initialize(self, first_observation: float):
        self.x = np.array([[first_observation],
                           [0.0]])
        self.P = np.eye(2)

    def predict(self):
        """
        Predict step of Kalman filter.
        x̂_k|k-1 = F * x̂_{k-1|k-1}
        P_k|k-1 = F * P_{k-1|k-1} * Fᵀ + Q
        """
        self.x = self.F @ self.x
        self.P = self.F @ self.P @ self.F.T + self.Q

    def update(self, observation: float):
        """
        Update step with new observation z_k.
        y_k = z_k - H * x̂_k|k-1                (innovation)
        S_k = H * P_k|k-1 * Hᵀ + R              (innovation covariance)
        K_k = P_k|k-1 * Hᵀ * S_k⁻¹              (Kalman gain)
        x̂_k|k = x̂_k|k-1 + K_k * y_k
        P_k|k = (I - K_k * H) * P_k|k-1
        """
        z = np.array([[observation]])
        y = z - self.H @ self.x
        S = self.H @ self.P @ self.H.T + self.R
        K = self.P @ self.H.T @ np.linalg.inv(S)
        self.x = self.x + K @ y
        I = np.eye(self.F.shape[0])
        self.P = (I - K @ self.H) @ self.P

    def current_state(self) -> float:
        """
        Returns the current level estimate (first component of state vector).
        """
        return float(self.x[0, 0])

    def current_variance(self) -> float:
        """
        Returns the variance of the level estimate (first diagonal element of covariance).
        """
        return float(self.P[0, 0])


def compute_confidence_multiplier(confidence_level: float) -> float:
    """
    Compute the z-score multiplier for a two‑sided normal confidence interval.

    For a confidence level α, the multiplier is:
        z = Φ⁻¹(0.5 + α/2)

    Where Φ⁻¹ is the inverse CDF of the standard normal distribution.
    """
    from scipy.stats import norm

    return float(norm.ppf(0.5 + confidence_level / 2.0))


@app.post("/forecast", response_model=ForecastResponse)
def forecast(request: ForecastRequest) -> ForecastResponse:
    """
    Endpoint that receives a time series, runs a Kalman filter with Bayesian updates,
    and returns forecasted values together with confidence intervals.
    """
    try:
        observations = request.observations
        steps = request.forecast_steps
        q = request.process_variance
        r = request.observation_variance
        conf_level = request.confidence_level

        if len(observations) < 2:
            raise HTTPException(status_code=400, detail="At least two observations are required.")

        kf = KalmanFilter1D(process_variance=q, observation_variance=r)
        kf.initialize(observations[0])

        # Process all observations
        for obs in observations[1:]:
            kf.predict()