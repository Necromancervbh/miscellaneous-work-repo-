import os
import logging
from typing import List, Tuple, Dict, Any
from functools import lru_cache

from fastapi import FastAPI, HTTPException, Depends
from pydantic import BaseModel, Field, validator
from neo4j import GraphDatabase, Neo4jError, basic_auth

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# FastAPI app
app = FastAPI(title="Anomaly Correlation Recommender")

# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class RecommendationRequest(BaseModel):
    anomaly_ids: List[str] = Field(..., description="List of anomaly identifiers")

    @validator("anomaly_ids")
    def non_empty(cls, v):
        if not v:
            raise ValueError("anomaly_ids must contain at least one ID")
        if any(not isinstance(i, str) or not i.strip() for i in v):
            raise ValueError("all anomaly IDs must be non‑empty strings")
        return v


class MitigationAction(BaseModel):
    mitigation_id: str = Field(..., description="Identifier of the mitigation action")
    description: str = Field(..., description="Human readable description")
    score: float = Field(..., description="Posterior risk score associated with this mitigation")


class RecommendationResponse(BaseModel):
    actions: List[MitigationAction] = Field(..., description="Top three recommended mitigation actions")


# ---------------------------------------------------------------------------
# Neo4j driver management
# ---------------------------------------------------------------------------

def get_neo4j_driver() -> GraphDatabase.driver:
    """Create a singleton Neo4j driver using environment variables."""
    uri = os.getenv("NEO4J_URI", "bolt://localhost:7687")
    user = os.getenv("NEO4J_USER", "neo4j")
    password = os.getenv("NEO4J_PASSWORD", "test")
    driver = GraphDatabase.driver(uri, auth=basic_auth(user, password))
    return driver


# Store driver in app state
@app.on_event("startup")
def startup_event():
    try:
        app.state.neo4j_driver = get_neo4j_driver()
        logger.info("Neo4j driver initialized")
    except Exception as exc:
        logger.exception("Failed to initialize Neo4j driver")
        raise exc


@app.on_event("shutdown")
def shutdown_event():
    driver: GraphDatabase.driver = app.state.neo4j_driver
    if driver:
        driver.close()
        logger.info("Neo4j driver closed")


def get_driver() -> GraphDatabase.driver:
    driver = getattr(app.state, "neo4j_driver", None)
    if driver is None:
        raise HTTPException(status_code=500, detail="Neo4j driver not initialized")
    return driver


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------

def _fetch_graph_data(anomaly_ids: List[str]) -> List[Dict[str, Any]]:
    """
    Query Neo4j for risks, priors, likelihoods and mitigations linked to the given anomalies.

    Returns a list of records:
    {
        "risk_id": str,
        "prior": float,
        "likelihood": float,
        "mitigation_id": str,
        "mitigation_desc": str
    }
    """
    query = """
    UNWIND $ids AS aid
    MATCH (a:Anomaly {id: aid})-[:AFFECTS]->(c:Component)-[:HAS_RISK]->(r:Risk)
    OPTIONAL MATCH (a)-[l:LIKELIHOOD]->(r)
    OPTIONAL MATCH (r)-[:MITIGATED_BY]->(m:Mitigation)
    RETURN r.id AS risk_id,
           r.prior AS prior,
           coalesce(l.likelihood, 0.0) AS likelihood,
           m.id AS mitigation_id,
           m.description AS mitigation_desc
    """
    driver = get_driver()
    try:
        with driver.session() as session:
            result = session.run(query, ids=anomaly_ids)
            records = []
            for record in result:
                records.append({
                    "risk_id": record["risk_id"],
                    "prior": float(record["prior"]),
                    "likelihood": float(record["likelihood"]),
                    "mitigation_id": record["mitigation_id"],
                    "mitigation_desc": record["mitigation_desc"]
                })
            return records
    except Neo4jError as exc:
        logger.exception("Neo4j query failed")
        raise HTTPException(status_code=500, detail="Database query error") from exc


def _compute_posteriors(records: List[Dict[str, Any]]) -> Dict[str, float]:
    """
    Compute posterior probability for each risk using Bayes theorem.

    Formula:
        posterior(risk) = (likelihood * prior) / evidence
    where evidence = Σ (likelihood_i * prior_i) over all risks.

    Returns a mapping risk_id -> posterior_score.
    """
    # Aggregate likelihood * prior per risk
    risk_weights: Dict[str, float] = {}
    for rec in records:
        weight = rec["likelihood"] * rec["prior"]
        risk_weights[rec["risk_id"]] = risk_weights.get(rec["risk_id"], 0.0) + weight

    evidence = sum(risk_weights.values())
    if evidence == 0:
        # Avoid division by zero; assign uniform low probability
        return {rid: 0.0 for rid in risk_weights}

    posteriors = {rid: weight / evidence for rid, weight in risk_weights.items()}
    return posteriors


def _