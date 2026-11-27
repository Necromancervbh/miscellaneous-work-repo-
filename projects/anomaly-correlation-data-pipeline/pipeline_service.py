import asyncio
import json
from typing import List, Optional

import asyncpg
import numpy as np
import pandas as pd
from fastapi import BackgroundTasks, FastAPI, HTTPException
from pydantic import BaseModel, Field, validator
from sklearn.decomposition import PCA
from sklearn.feature_extraction.text import TfidfVectorizer

app = FastAPI(title="Anomaly Correlation Data Pipeline")

# ------------------------------
# Configuration
# ------------------------------
DB_DSN = "postgresql://user:password@localhost:5432/anomaly_db"
TABLE_NAME = "processed_sensor_data"

# ------------------------------
# Pydantic models
# ------------------------------
class SensorData(BaseModel):
    sensor_id: str = Field(..., description="Unique identifier for the sensor")
    timestamps: List[float] = Field(..., description="Unix timestamps for each measurement")
    values: List[float] = Field(..., description="Raw sensor measurements")
    tags: List[str] = Field(..., description="Categorical tags associated with the measurement batch")

    @validator("timestamps")
    def timestamps_must_match_values(cls, v, values):
        if "values" in values and len(v) != len(values["values"]):
            raise ValueError("Length of timestamps must match length of values")
        return v

    @validator("values")
    def values_non_empty(cls, v):
        if not v:
            raise ValueError("Values list cannot be empty")
        return v

    @validator("tags")
    def tags_non_empty(cls, v):
        if not v:
            raise ValueError("Tags list cannot be empty")
        return v

# ------------------------------
# Database utilities
# ------------------------------
class DB:
    _pool: Optional[asyncpg.Pool] = None

    @classmethod
    async def init(cls):
        cls._pool = await asyncpg.create_pool(dsn=DB_DSN, min_size=1, max_size=5)

    @classmethod
    async def close(cls):
        if cls._pool:
            await cls._pool.close()

    @classmethod
    async def execute(cls, query: str, *args):
        if not cls._pool:
            raise RuntimeError("Database pool is not initialized")
        async with cls._pool.acquire() as conn:
            await conn.execute(query, *args)

# ------------------------------
# Kalman filter implementation
# ------------------------------
def kalman_smooth(values: List[float]) -> List[float]:
    """
    Simple 1‑D Kalman filter for smoothing.
    Model:
        x_k = x_{k-1} + w_k,   w_k ~ N(0, Q)
        z_k = x_k + v_k,       v_k ~ N(0, R)
    Where Q is process variance and R is measurement variance.
    """
    Q = 1e-5  # process variance
    R = 0.01  # measurement variance
    n = len(values)
    if n == 0:
        return []

    # Initial guesses
    x_est = values[0]
    P = 1.0

    smoothed = []
    for z in values:
        # Prediction step
        x_pred = x_est
        P_pred = P + Q

        # Update step
        K = P_pred / (P_pred + R)  # Kalman gain
        x_est = x_pred + K * (z - x_pred)
        P = (1 - K) * P_pred

        smoothed.append(float(x_est))
    return smoothed

# ------------------------------
# TF‑IDF computation
# ------------------------------
def compute_tfidf(tags: List[str]) -> np.ndarray:
    """
    Compute TF‑IDF vector for a list of tags.
    Since tags are short, we treat each tag as a document.
    """
    vectorizer = TfidfVectorizer(token_pattern=r"(?u).+")
    tfidf_matrix = vectorizer.fit_transform(tags)
    # Reduce to a single vector by averaging across documents
    tfidf_vector = tfidf_matrix.mean(axis=0).A1
    return tfidf_vector

# ------------------------------
# PCA dimensionality reduction
# ------------------------------
def apply_pca(features: np.ndarray, n_components: int = 3) -> np.ndarray:
    """
    Reduce feature dimensionality using PCA.
    """
    if features.ndim == 1:
        features = features.reshape(1, -1)
    pca = PCA(n_components=n_components)
    components = pca.fit_transform(features)
    # Return the first row (since we usually have a single sample)
    return components[0]

# ------------------------------
# Core processing pipeline
# ------------------------------
async def process_and_store(data: SensorData):
    try:
        # 1. Kalman smoothing
        smoothed_values = kalman_smooth(data.values)

        # 2. TF‑IDF on tags
        tfidf_vector = compute_tfidf(data.tags)

        # 3. Combine features for PCA
        #    We concatenate the smoothed values (as a summary statistic) with TF‑IDF.
        #    For simplicity, use mean and std of smoothed values.
        mean_val = np.mean(smoothed_values)
        std_val = np.std(smoothed_values)
        combined_features = np.concatenate(
            ([mean_val, std_val], tfidf_vector)
        )

        # 4. PCA reduction
        pca_components = apply_pca(combined_features, n_components=3)

        # 5. Prepare JSON payloads for DB insertion
        smoothed_json = json.dumps(smoothed_values)
        tfidf_json = json.dumps(tfidf_vector.tolist())
        pca_json = json.dumps(pca_components.tolist())

        # 6. Insert into PostgreSQL
        insert_query = f"""
            INSERT INTO {TABLE_NAME} 
            (sensor_id, processed_timestamp, smoothed_values, tfidf_vector, pca_components)
            VALUES ($1, NOW(), $2::jsonb, $3::jsonb, $4::jsonb);
        """
        await DB.execute(
            insert_query,
            data.sensor_id,
            smoothed_json,
            tfidf_json,
            pca_json,
        )
    except Exception as exc:
        # Log the error; in production use proper logging framework
        print(f"Error processing sensor data for sensor_id={data.sensor_id}: {exc}")
        raise

# ------------------------------
# FastAPI endpoints
# ------------------------------
@app.on_event("startup")
async def startup_event():
    await DB.init()
    # Ensure target table exists
    create_table_sql = f"""
        CREATE TABLE IF NOT EXISTS {TABLE_NAME} (
            id SERIAL PRIMARY KEY,
            sensor_id TEXT NOT NULL,
            processed_timestamp TIMESTAMPTZ NOT NULL,
            smoothed_values JSONB NOT NULL,
            tfidf_vector JSONB NOT NULL,
            pca_components JSONB NOT NULL
        );
    """
    await DB.execute(create_table_sql)

@app.on_event("shutdown")
async def shutdown_event():
    await DB.close()

@app.post("/ingest", status_code=202, summary="Ingest raw sensor data")
async def ingest_sensor_data(payload: SensorData, background_tasks: BackgroundTasks):
    """
    Accept raw sensor stream, schedule asynchronous processing,
    and immediately return a 202 Accepted response.
    """
    # Basic validation already performed by Pydantic
    background_tasks.add_task(process_and_store, payload)
    return {"detail": "Processing scheduled"}

# ------------------------------
# Health check
# ------------------------------
@app.get("/healthz", summary="Health check")
async def health_check():
    try:
        await DB.execute("SELECT 1")
        return {"status": "ok"}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc))