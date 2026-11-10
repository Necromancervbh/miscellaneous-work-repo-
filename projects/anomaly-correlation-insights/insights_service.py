import json
from typing import List, Optional, Dict, Any

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, validator
from sklearn.decomposition import PCA
from pykalman import KalmanFilter
import shap

# Assume the Bayesian explainability engine is provided in the same package
# and exposes a class `BayesianExplainabilityEngine` with a method `predict`
# that accepts a 2‑D numpy array and returns predictions.
# The engine also provides a method `get_model` that returns an object
# compatible with SHAP (i.e., implements a `predict` method).
try:
    from .bayesian_engine import BayesianExplainabilityEngine
except ImportError as e:
    raise ImportError("BayesianExplainabilityEngine module is required.") from e

app = FastAPI(title="Anomaly Correlation Insights Engine")


class TimeSeriesRequest(BaseModel):
    """
    Expected JSON payload:
    {
        "timestamps": [float, ...],
        "features": [[float, ...], ...],
        "feature_names": ["f1", "f2", ...]  # optional
    }
    """
    timestamps: List[float] = Field(..., description="List of timestamps corresponding to each observation.")
    features: List[List[float]] = Field(..., description="2‑D list where each inner list represents a feature vector at a timestamp.")
    feature_names: Optional[List[str]] = Field(None, description="Optional list of feature names.")

    @validator("features")
    def check_features_non_empty(cls, v):
        if not v:
            raise ValueError("features must contain at least one observation.")
        return v

    @validator("timestamps")
    def check_lengths_match(cls, v, values):
        features = values.get("features")
        if features and len(v) != len(features):
            raise ValueError("Length of timestamps must match number of feature vectors.")
        return v

    @validator("feature_names")
    def check_feature_names_length(cls, v, values):
        features = values.get("features")
        if v and features:
            expected_len = len(features[0])
            if len(v) != expected_len:
                raise ValueError("feature_names length must match number of features per observation.")
        return v


class FeatureContribution(BaseModel):
    feature: str
    contribution: float
    lower_ci: float
    upper_ci: float


class InsightResponse(BaseModel):
    contributions: List[FeatureContribution]


# Global singleton for the Bayesian engine
bayesian_engine = BayesianExplainabilityEngine()


def apply_pca(data: np.ndarray, variance_threshold: float = 0.95) -> (np.ndarray, PCA):
    """
    Apply PCA to retain enough components to explain `variance_threshold` of variance.
    Formula: X_reduced = X * W where W contains the selected eigenvectors.
    """
    pca = PCA()
    pca.fit(data)
    cumulative_variance = np.cumsum(pca.explained_variance_ratio_)
    n_components = np.searchsorted(cumulative_variance, variance_threshold) + 1
    pca = PCA(n_components=n_components)
    reduced = pca.fit_transform(data)
    return reduced, pca


def apply_kalman_filter(data: np.ndarray) -> np.ndarray:
    """
    Apply a simple Kalman filter for smoothing.
    State transition matrix (A) and observation matrix (H) are identity.
    """
    n_dim = data.shape[1]
    kf = KalmanFilter(
        transition_matrices=np.eye(n_dim),
        observation_matrices=np.eye(n_dim),
        transition_covariance=0.01 * np.eye(n_dim),
        observation_covariance=0.1 * np.eye(n_dim),
        initial_state_mean=data[0],
        initial_state_covariance=np.eye(n_dim)
    )
    smoothed_state_means, _ = kf.smooth(data)
    return smoothed_state_means


def compute_shap_values(model, data: np.ndarray, background: np.ndarray) -> np.ndarray:
    """
    Compute SHAP values using KernelExplainer (model‑agnostic).
    Returns an array of shape (samples, features).
    """
    explainer = shap.KernelExplainer(model.predict, background)
    shap_values = explainer.shap_values(data, nsamples=100)
    # KernelExplainer returns a list when model output is multi‑dimensional;
    # we assume a single output and take the first element.
    if isinstance(shap_values, list):
        shap_values = shap_values[0]
    return np.array(shap_values)


def confidence_interval(values: np.ndarray, confidence: float = 0.95) -> (float, float):
    """
    Compute two‑sided confidence interval using normal approximation.
    CI = mean ± z * (std / sqrt(N)), where z is the quantile of the standard normal.
    """
    mean = np.mean(values)
    std_err = np.std(values, ddof=1) / np.sqrt(len(values))
    z = 1.96  # Approximation for 95% confidence
    lower = mean - z * std_err
    upper = mean + z * std_err
    return lower, upper


@app.post("/insights", response_model=InsightResponse)
def generate_insights(request: TimeSeriesRequest) -> InsightResponse:
    try:
        # Convert input to numpy array
        data = np.array(request.features, dtype=float)
        if data.ndim != 2:
            raise ValueError("features must be a 2‑dimensional array.")
        n_samples, n_features = data.shape

        # Default feature names if not provided
        feature_names = request.feature_names or [f"f{i+1}" for i in range(n_features)]

        # Step 1: PCA
        pca_data, pca = apply_pca(data)

        # Step 2: Kalman filter smoothing
        smoothed_data = apply_kalman_filter(pca_data)

        # Step 3: Bayesian explainability engine prediction
        # The engine expects data in the original feature space; we inverse transform
        # to approximate original scale before feeding to the model.
        reconstructed = pca.inverse_transform(smoothed_data)
        predictions = bayesian_engine.predict(reconstructed)

        # Step 4: SHAP value computation
        # Use a subset of the reconstructed data as background for KernelExplainer
        background_idx = np.random.choice(len(reconstructed), size=min(100, len(reconstructed)), replace=False)
        background = reconstructed[background_idx]
        model = bayesian