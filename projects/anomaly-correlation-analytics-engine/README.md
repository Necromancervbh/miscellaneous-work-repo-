# Anomaly Correlation Analytics Engine  

**Category:** Data Science  
**Stack:** TypeScript / Node.js / Python  

Aggregates alerts from heterogeneous sources, runs machine‑learning pipelines to discover correlated anomalies, and serves actionable insights through a RESTful API.

---  

## Overview  

The **Anomaly Correlation Analytics Engine (ACAE)** is a modular platform that:

* **Ingests** raw alerts (JSON, CSV, streaming logs) via a lightweight Node.js collector.  
* **Normalises** and stores them in a time‑series data store (e.g., PostgreSQL + TimescaleDB).  
* **Executes** Python‑based ML pipelines (feature engineering, clustering, correlation scoring).  
* **Exposes** the resulting insights (anomaly scores, correlated groups, root‑cause suggestions) through a TypeScript‑powered Express API.  

Designed for scalability, ACAE can be deployed on a single machine for prototyping or scaled horizontally with Docker/Kubernetes for production workloads.

---  

## Theory & Architecture  

```
+-------------------+        +-------------------+        +-------------------+
|   Alert Sources   | --->   |   Node.js Ingest  | --->   |   PostgreSQL/TSDB |
+-------------------+        +-------------------+        +-------------------+
                                   |                               |
                                   |  (batch / stream)             |
                                   v                               v
                         +-------------------+        +-------------------+
                         |  Python Scheduler | --->   |  ML Pipelines     |
                         +-------------------+        +-------------------+
                                   |                               |
                                   |  (model artifacts, scores)    |
                                   v                               v
                         +-------------------+        +-------------------+
                         |  TypeScript API   | <---   |  Insight Service |
                         +-------------------+        +-------------------+
```

### Core Components  

| Component | Language | Responsibility |
|-----------|----------|----------------|
| **Collector** | TypeScript (Node.js) | HTTP/WS ingestion, schema validation, deduplication |
| **Storage** | PostgreSQL + TimescaleDB | Persistent, time‑series‑optimised storage |
| **Scheduler** | Python (APScheduler) | Triggers nightly/real‑time ML jobs |
| **ML Pipelines** | Python (scikit‑learn, pandas, PyTorch) | Feature extraction, clustering (DBSCAN/HDBSCAN), correlation scoring, model versioning |
| **Insight Service** | Python | Generates human‑readable explanations, ranking of correlated anomalies |
| **API Gateway** | TypeScript (Express) | REST endpoints (`/insights`, `/models`, `/health`), authentication, rate‑limiting |
| **Observability** | Mixed | Prometheus metrics, Grafana dashboards, structured logs (Winston) |

### Data Flow  

1. **Ingestion** – Alerts arrive as JSON payloads (`/ingest`). The collector validates against a JSON Schema, enriches with source metadata, and writes to the time‑series table.  
2. **Batching** – Every N minutes (configurable) the scheduler extracts the newest window of alerts.  
3. **Feature Engineering** – Python transforms raw fields into numeric vectors (e.g., one‑hot encoding, time‑delta features).  
4. **Correlation Modeling** –  
   * **Clustering** groups alerts that share similar feature vectors.  
   * **Correlation Score** = `sim(a,b) * temporal_weight` where `sim` is cosine similarity.  
5. **Persistence** – Scores and cluster IDs are written back to the DB.  
6. **Serving** – The API reads the latest insights and returns JSON responses, optionally filtered by time range, severity, or source.

---  

## Quickstart  

### Prerequisites  

* Node.js ≥ 18  
* Python ≥ 3.9  
* PostgreSQL ≥ 13 with TimescaleDB extension  
* `npm` and `pip` available in PATH  

### 1. Clone the repository  

```bash
git clone https://github.com/yourorg/anomaly-correlation-analytics-engine.git
cd anomaly-correlation-analytics-engine
```

### 2. Install backend (Node.js)  

```bash
cd backend
npm ci               # install exact versions from package-lock.json
npm run db:migrate   # create tables (uses pg-migrate)
```

### 3. Install ML stack (Python)  

```bash
cd ../ml
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 4. Start services (development mode)  

```bash
# Terminal 1 – PostgreSQL (if not already running)
docker compose up -d postgres

# Terminal 2 – Node.js collector & API
cd backend
npm run dev          # watches src/**/*.ts