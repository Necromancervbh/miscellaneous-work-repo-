import os
import json
import logging
from typing import Dict, List, Any

import pandas as pd
import numpy as np
import pymc3 as pm
import jwt
from fastapi import FastAPI, Depends, HTTPException, Header, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, ValidationError
from celery import Celery
from celery.result import AsyncResult
from starlette.status import HTTP_401_UNAUTHORIZED, HTTP_400_BAD_REQUEST, HTTP_500_INTERNAL_SERVER_ERROR

# ----------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------
JWT_SECRET = os.getenv("JWT_SECRET", "your-secret-key")
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
CELERY_BROKER_URL = os.getenv("CELERY_BROKER_URL", "redis://localhost:6379/0")
CELERY_RESULT_BACKEND = os.getenv("CELERY_RESULT_BACKEND", "redis://localhost:6379/0")
ANOMALY_DATASET_PATH = os.getenv("ANOMALY_DATASET_PATH", "data/anomaly_dataset.csv")
CELERY_TASK_TIMEOUT = int(os.getenv("CELERY_TASK_TIMEOUT", "30"))  # seconds
TOP_FEATURE_COUNT = int(os.getenv("TOP_FEATURE_COUNT", "3"))

# ----------------------------------------------------------------------
# Logging
# ----------------------------------------------------------------------
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ----------------------------------------------------------------------
# FastAPI app
# ----------------------------------------------------------------------
app = FastAPI(title="Anomaly Correlation Explainability Service")

# ----------------------------------------------------------------------
# Celery app
# ----------------------------------------------------------------------
celery_app = Celery(
    "explainability_tasks",
    broker=CELERY_BROKER_URL,
    backend=CELERY_RESULT_BACKEND,
)
celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
)

# ----------------------------------------------------------------------
# Pydantic models
# ----------------------------------------------------------------------
class ExplainRequest(BaseModel):
    features: Dict[str, float] = Field(..., description="Mapping of feature names to their numeric values")

class ExplainResponse(BaseModel):
    probability_score: float = Field(..., description="Probability of anomaly according to the Bayesian posterior")
    top_features: List[Dict[str, Any]] = Field(..., description="Top contributing features with importance scores")

# ----------------------------------------------------------------------
# JWT utilities
# ----------------------------------------------------------------------
def verify_jwt(authorization: str = Header(..., description="Bearer JWT token")) -> Dict[str, Any]:
    """
    Validates the JWT token from the Authorization header.
    Expected format: "Bearer <token>"
    Returns the decoded payload if valid, raises HTTPException otherwise.
    """
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=HTTP_401_UNAUTHORIZED, detail="Invalid Authorization header format")
    token = authorization.split(" ", 1)[1]
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=HTTP_401_UNAUTHORIZED, detail="Token has expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=HTTP_401_UNAUTHORIZED, detail="Invalid token")

# ----------------------------------------------------------------------
# Celery task
# ----------------------------------------------------------------------
@celery_app.task(name="compute_bayesian_posterior")
def compute_bayesian_posterior(features: Dict[str, float]) -> Dict[str, Any]:
    """
    Loads the anomaly dataset, fits a Bayesian logistic regression model using PyMC3,
    and computes the posterior probability for the supplied feature vector.
    Returns a dictionary with probability_score and top_features.
    """
    # Load dataset
    if not os.path.isfile(ANOMALY_DATASET_PATH):
        raise FileNotFoundError(f"Dataset not found at {ANOMALY_DATASET_PATH}")

    df = pd.read_csv(ANOMALY_DATASET_PATH)
    if "target" not in df.columns:
        raise ValueError("Dataset must contain a 'target' column indicating anomaly (0/1)")

    # Separate features and target
    feature_cols = [col for col in df.columns if col != "target"]
    X = df[feature_cols].values
    y = df["target"].values

    # Ensure input features match dataset columns
    missing = set(feature_cols) - set(features.keys())
    if missing:
        raise ValueError(f"Missing features for model: {missing}")

    # Convert input features to ordered numpy array
    input_vector = np.array([features[col] for col in feature_cols], dtype=np.float64)

    n_features = X.shape[1]

    # Bayesian logistic regression model
    with pm.Model() as model:
        # Priors: Normal(0, 10) for coefficients and intercept
        coeffs = pm.Normal("coeffs", mu=0, sigma=10, shape=n_features)
        intercept = pm.Normal("intercept", mu=0, sigma=10)

        # Linear predictor
        mu = intercept + pm.math.dot(X, coeffs)

        # Likelihood
        y_obs = pm.Bernoulli("y_obs", logit_p=mu, observed=y)

        # Sampling (using NUTS)
        trace = pm.sample(
            draws=1000,
            tune=1000,
            cores=1,
            chains=2,
            progressbar=False,
            random_seed=42,
            target_accept=0.9,