import os
import logging
from typing import List, Optional, Dict, Any

import pandas as pd
import numpy as np

from fastapi import FastAPI, HTTPException, Depends, Query, Body, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, validator, conlist, PositiveInt, constr

from sqlalchemy import (
    Column,
    Integer,
    String,
    Float,
    UniqueConstraint,
    create_engine,
    select,
    func,
)
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker, declarative_base

import pymc as pm
import arviz as az

# ----------------------------------------------------------------------
# Configuration & Logging
# ----------------------------------------------------------------------
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql+asyncpg://postgres:postgres@localhost:5432/explainability"
)

# ----------------------------------------------------------------------
# Database setup
# ----------------------------------------------------------------------
Base = declarative_base()


class FeatureScore(Base):
    __tablename__ = "feature_scores"
    __table_args__ = (UniqueConstraint("feature_name", "group_id", name="uq_feature_group"),)

    id = Column(Integer, primary_key=True, index=True)
    feature_name = Column(String, nullable=False, index=True)
    group_id = Column(Integer, nullable=False, index=True)
    correlation_score = Column(Float, nullable=False)


engine = create_async_engine(DATABASE_URL, echo=False, future=True)
AsyncSessionLocal = sessionmaker(
    bind=engine, class_=AsyncSession, expire_on_commit=False, autoflush=False
)


async def get_db() -> AsyncSession:
    async with AsyncSessionLocal() as session:
        yield session


# ----------------------------------------------------------------------
# Pydantic models
# ----------------------------------------------------------------------
class ScoreIngestItem(BaseModel):
    feature_name: constr(strip_whitespace=True, min_length=1)
    group_id: PositiveInt
    correlation_score: float = Field(..., ge=-1.0, le=1.0)

    @validator("correlation_score")
    def check_score_range(cls, v):
        if not -1.0 <= v <= 1.0:
            raise ValueError("correlation_score must be between -1 and 1")
        return v


class ScoreIngestRequest(BaseModel):
    scores: conlist(ScoreIngestItem, min_items=1)


class RankedFeature(BaseModel):
    feature_name: str
    posterior_mean_weight: float
    posterior_std_weight: float
    rank: int


class RankedResponse(BaseModel):
    ranked_features: List[RankedFeature]


# ----------------------------------------------------------------------
# Bayesian hierarchical model
# ----------------------------------------------------------------------
def _build_hierarchical_model(df: pd.DataFrame) -> pm.Model:
    """
    Build a Bayesian hierarchical model.

    Model specification:
        y_ij ~ Normal(theta_i, sigma_obs)          # observed correlation scores
        theta_i ~ Normal(mu_group[g_i], sigma_theta)  # feature-level importance per group
        mu_group[g] ~ Normal(0, sigma_group)       # group-level mean
        sigma_* ~ HalfNormal(1)                    # weakly informative priors
    """
    groups = df["group_id"].unique()
    features = df["feature_name"].unique()
    group_idx = pd.Categorical(df["group_id"], categories=groups).codes
    feature_idx = pd.Categorical(df["feature_name"], categories=features).codes
    y = df["correlation_score"].values

    with pm.Model() as hierarchical_model:
        sigma_group = pm.HalfNormal("sigma_group", sigma=1.0)
        sigma_theta = pm.HalfNormal("sigma_theta", sigma=1.0)
        sigma_obs = pm.HalfNormal("sigma_obs", sigma=1.0)

        mu_group = pm.Normal("mu_group", mu=0.0, sigma=sigma_group, shape=len(groups))

        theta = pm.Normal(
            "theta",
            mu=mu_group[group_idx],
            sigma=sigma_theta,
            shape=len(features),
        )

        # Likelihood
        pm.Normal("y_obs", mu=theta[feature_idx], sigma=sigma_obs, observed=y)

    return hierarchical_model


def compute_posterior_weights(df: pd.DataFrame) -> pd.DataFrame:
    """
    Compute posterior importance weights for each feature using a Bayesian hierarchical model.

    Returns a DataFrame with columns:
        feature_name, posterior_mean, posterior_std
    """
    if df.empty:
        raise ValueError("Input DataFrame is empty")

    model = _build_hierarchical_model(df)

    # Use Variational Inference for speed in a service context
    with model:
        approx = pm.fit(
            method="advi",
            n=20000,
            progressbar=False,
        )
        posterior = approx.sample(1000)

    # Extract posterior of theta (feature-level importance)
    theta_samples = posterior.posterior["theta"].stack(draws=("chain", "draw")).values
    feature_names = df["feature_name"].unique()

    means = theta_samples.mean(axis=1)
    stds = theta_samples.std(axis=1)

    result = pd.DataFrame(
        {
            "feature_name": feature_names,
            "posterior_mean_weight": means,
            "posterior_std_weight": stds,
        }
    )
    result.sort_values(by="posterior_mean_weight", ascending=False, inplace=True)
    result["rank"] = np.arange(1, len(result) + 1)
    return result


# ----------------------------------------------------------------------
# FastAPI application
# ----------------------------------------------------------------------
app = FastAPI(title="Anomaly Correlation Explainability Service")


@app.on_event("startup")
async def startup_event():
    # Ensure tables exist
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


@app.post(
    "/ingest",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=Dict[str, Any],
    summary="Ingest correlation scores",
)
async def ingest_scores(
    payload: ScoreIngestRequest = Body(...),
    db: AsyncSession = Depends(get_db),
):
    """
    Store correlation scores in the database.
    """
    try:
        objs = [
            FeatureScore(
                feature_name=item.feature_name,
                group_id=item.group_id,
                correlation_score=item.correlation_score,
            )
            for item in payload.scores
        ]
        db.add_all(objs)
        await db.commit()
        return {"status": "accepted", "ingested": len(objs)}
    except Exception as exc:
        await db.rollback()
        logger.exception("Failed to ingest scores")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        )


@app.get(
    "/ranked",
    response_model=RankedResponse,
    summary="Get ranked feature contributions",
)
async def get_ranked_features(
    group_ids: Optional[List[int]] = Query(
        None,
        description="Filter scores by one or more group IDs. If omitted, all groups are used.",
    ),
    db: AsyncSession = Depends(get_db),
):
    """
    Compute posterior importance weights and return ranked features.
    """
    try:
        stmt = select(
            FeatureScore.feature_name,
            FeatureScore.group_id,
            FeatureScore.correlation_score,
        )
        if group_ids:
            stmt = stmt.where(FeatureScore.group_id.in_(group_ids))

        result = await db.execute(stmt)
        rows = result.fetchall()
        if not rows:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No correlation scores found for the specified groups.",
            )
        df = pd.DataFrame(
            rows,
            columns=["feature_name", "group_id", "correlation_score"],
        )
        ranked_df = compute_posterior_weights(df)

        ranked_features = [
            Ranked