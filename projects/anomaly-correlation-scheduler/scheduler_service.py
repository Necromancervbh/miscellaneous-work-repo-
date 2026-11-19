import os
import uuid
import logging
from datetime import datetime, timezone
from typing import Optional

import asyncio
from fastapi import FastAPI, HTTPException, BackgroundTasks, Depends, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, validator

from celery import Celery, states
from celery.result import AsyncResult
from celery.exceptions import CeleryError

from influxdb_client import InfluxDBClient, Point, WritePrecision
from influxdb_client.client.write_api import SYNCHRONOUS

# ----------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------
REDIS_BROKER_URL = os.getenv("REDIS_BROKER_URL", "redis://localhost:6379/0")
REDIS_BACKEND_URL = os.getenv("REDIS_BACKEND_URL", "redis://localhost:6379/1")
INFLUXDB_URL = os.getenv("INFLUXDB_URL", "http://localhost:8086")
INFLUXDB_TOKEN = os.getenv("INFLUXDB_TOKEN", "my-token")
INFLUXDB_ORG = os.getenv("INFLUXDB_ORG", "my-org")
INFLUXDB_BUCKET = os.getenv("INFLUXDB_BUCKET", "aggregations")

# ----------------------------------------------------------------------
# Logging
# ----------------------------------------------------------------------
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("scheduler_service")

# ----------------------------------------------------------------------
# Celery setup
# ----------------------------------------------------------------------
celery_app = Celery(
    "aggregator",
    broker=REDIS_BROKER_URL,
    backend=REDIS_BACKEND_URL,
    include=["scheduler_service"],
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    result_expires=86400,  # keep results for 1 day
)

# ----------------------------------------------------------------------
# InfluxDB client (singleton)
# ----------------------------------------------------------------------
class InfluxClientSingleton:
    _client: Optional[InfluxDBClient] = None

    @classmethod
    def get_client(cls) -> InfluxDBClient:
        if cls._client is None:
            cls._client = InfluxDBClient(
                url=INFLUXDB_URL,
                token=INFLUXDB_TOKEN,
                org=INFLUXDB_ORG,
            )
        return cls._client

# ----------------------------------------------------------------------
# Pydantic models
# ----------------------------------------------------------------------
class ScheduleRequest(BaseModel):
    """Request payload to schedule a daily aggregation job."""
    start_date: datetime = Field(..., description="ISO8601 start date (inclusive) for aggregation")
    end_date: datetime = Field(..., description="ISO8601 end date (exclusive) for aggregation")
    metric_name: str = Field(..., min_length=1, max_length=100, description="Name of the metric to aggregate")
    aggregation_type: str = Field(
        ...,
        regex="^(sum|avg|min|max|count)$",
        description="Aggregation operation to perform",
    )

    @validator("end_date")
    def end_must_be_after_start(cls, v, values):
        if "start_date" in values and v <= values["start_date"]:
            raise ValueError("end_date must be after start_date")
        return v

class ScheduleResponse(BaseModel):
    job_id: str
    status: str = "queued"

class StatusResponse(BaseModel):
    job_id: str
    status: str
    result_url: Optional[str] = None
    error: Optional[str] = None

# ----------------------------------------------------------------------
# Core aggregation logic (executed by Celery worker)
# ----------------------------------------------------------------------
@celery_app.task(bind=True, name="aggregate_daily")
def aggregate_daily(self, job_id: str, start_iso: str, end_iso: str, metric_name: str, aggregation_type: str):
    """
    Perform aggregation for the given time window and persist the result.

    Formula (example for sum):
        result = Σ_{t ∈ [start, end)} value(metric_name, t)

    The function writes a point to InfluxDB with fields:
        - aggregation_type
        - result
    """
    try:
        logger.info(
            "Starting aggregation job %s: %s %s -> %s (%s)",
            job_id,
            metric_name,
            aggregation_type,
            f"{start_iso}/{end_iso}",
            datetime.utcnow().isoformat(),
        )
        # Simulated data retrieval and aggregation.
        # In a real implementation, replace this with actual data source queries.
        import random

        # Simulate 24 hourly data points
        data_points = [random.uniform(0, 100) for _ in range(24)]

        if aggregation_type == "sum":
            result = sum(data_points)
        elif aggregation_type == "avg":
            result = sum(data_points) / len(data_points)
        elif aggregation_type == "min":
            result = min(data_points)
        elif aggregation_type == "max":
            result = max(data_points)
        elif aggregation_type == "count":
            result = len(data_points)
        else:
            raise ValueError(f"Unsupported aggregation type: {aggregation_type}")

        # Persist to InfluxDB
        client = InfluxClientSingleton.get_client()
        write_api = client.write_api(write_options=SYNCHRONOUS)

        point = (
            Point("daily_aggregation")
            .tag("metric", metric_name)
            .field("aggregation_type", aggregation_type)
            .field("result", float(result))
            .time(datetime.utcnow(), WritePrecision.NS)
        )
        write_api.write(bucket=INFLUXDB_BUCKET, org=INFLUXDB_ORG, record=point)

        logger.info("Aggregation job %s completed successfully", job_id)
        return {"job_id": job_id, "status": "completed", "result": result}
    except Exception as exc:
        logger.exception("Aggregation job %s failed", job_id)
        self.update_state(state=states.FAILURE, meta={"exc_message": str(exc)})
        raise

# ----------------------------------------------------------------------
# FastAPI application
# ----------------------------------------------------------------------
app = FastAPI(title="Anomaly Correlation Scheduler", version="1.0.0")

def get_celery_result(job_id: str) -> AsyncResult:
    return AsyncResult(job_id, app=celery_app)

@app.post("/schedule", response_model=ScheduleResponse, status_code=202)
async def schedule_aggregation(request: ScheduleRequest):
    """
    Enqueue a daily aggregation job.
    """
    job_id = str(uuid.uuid4())
    try:
        # Convert datetimes to ISO strings in UTC
        start_iso = request.start_date.astimezone(timezone.utc).isoformat()
        end_iso = request.end_date.astimezone(timezone.utc).isoformat()

        # Enqueue Celery task
        celery_app.send_task(
            "aggregate_daily",
            args=[job_id, start_iso, end_iso, request.metric_name, request.aggregation_type],
            task_id=job_id,
        )
        logger.info("Enqueued aggregation job %s", job_id)
        return ScheduleResponse(job_id=job_id)
    except CeleryError as ce:
        logger.exception("Failed to enqueue job")
        raise HTTPException(status_code=500, detail=f"Task queue error: {str(ce)}")

@app.get("/status/{job_id}", response_model=StatusResponse)
async def get_job_status(job_id: str = Query(..., description="Celery task ID")):
    """
    Retrieve the status of a previously scheduled job.
    """
    result = get_celery_result(job_id)
    state = result.state

    if state == states.PENDING:
        # Task not found or not yet started
        status = "queued"
    elif state == states.STARTED:
        status = "running"
    elif state == states.SUCCESS:
        status = "completed"
    elif state == states.FAILURE:
        status = "failed"
    else:
        status = state.lower()

    response = StatusResponse(job_id=job_id, status=status)

    if state == states.SUCCESS:
        # Provide a URL to query the result if needed; placeholder implementation
        response.result