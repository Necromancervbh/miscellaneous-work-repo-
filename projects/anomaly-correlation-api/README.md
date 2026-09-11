# Anomaly Correlation API

**Category:** Data Science  
**Stack:** TypeScript / Node.js  

A lightweight, production‑ready REST API that centralises anomaly detection, correlation analysis, dashboard visualisation, and notification delivery. It provides a single entry point for data scientists, engineers, and product teams to ingest raw metrics, compute statistical relationships, and trigger downstream actions.

---  

## Overview  

The **Anomaly Correlation API** abstracts the end‑to‑end workflow of modern observability platforms:

| Feature | Description |
|---------|-------------|
| **Ingestion** | Accepts time‑series data points (JSON or CSV) via HTTP POST. |
| **Correlation Engine** | Computes Pearson, Spearman, and custom similarity scores across arbitrary metric dimensions. |
| **Anomaly Scoring** | Flags outliers using configurable statistical thresholds (z‑score, IQR, MAD). |
| **Dashboard Integration** | Exposes aggregated results for front‑end visualisation (heatmaps, time‑series plots). |
| **Notifier** | Emits webhook or email alerts when correlated anomalies cross severity levels. |
| **Analytics** | Provides historical query endpoints for trend analysis and model validation. |

All functionality is exposed through a clean, versioned REST interface (`/v1/*`). The service is container‑friendly, stateless, and can be horizontally scaled behind a load balancer.

---  

## Theory & Architecture  

### 1. Data Flow  

```
Client → HTTP POST /v1/ingest → Validation → Storage (PostgreSQL + TimescaleDB)
      ↘︎                     ↘︎
   /v1/correlate          /v1/anomalies
      ↘︎                     ↘︎
   Correlation Engine   Anomaly Detector
      ↘︎                     ↘︎
   Results (JSON) → Dashboard / Notifier
```

1. **Ingestion** – Incoming payloads are validated against a JSON schema (AJV). Valid records are written to a time‑series‑optimised PostgreSQL schema.  
2. **Correlation Engine** – Runs as a background worker (BullMQ) that batches new data, computes pairwise similarity matrices, and persists the top‑k relationships.  
3. **Anomaly Detector** – Applies statistical tests on each metric stream; anomalous points are enriched with correlation context.  
4. **Notifier** – Subscribes to the anomaly event stream (Redis Pub/Sub) and dispatches alerts via configurable channels (webhook, Slack, email).  

### 2. Core Algorithms  

| Algorithm | Purpose | Complexity |
|-----------|---------|------------|
| **Pearson Correlation** | Linear relationship between two numeric series | `O(N)` per pair |
| **Spearman Rank Correlation** | Monotonic relationship, robust to outliers | `O(N log N)` per pair (due to sorting) |
| **Dynamic Thresholding** (z‑score, IQR) | Detect outliers in streaming data | `O(1)` amortised per point (online statistics) |
| **Top‑K Pair Selection** | Keep only the most significant correlations | `O(P log K)` where `P` = number of pairs processed |

The worker processes data in **chunks** (default 10 000 rows) to keep memory usage bounded. Correlation matrices are stored sparsely; only pairs exceeding a configurable significance threshold are persisted.

### 3. System Components  

| Component | Technology | Responsibility |
|-----------|------------|----------------|
| **API Server** | Express + TypeScript | Request routing, schema validation, auth |
| **Background Workers** | BullMQ + Redis | Batch processing, correlation computation |
| **Database** | PostgreSQL + TimescaleDB extension | Time‑series storage, fast range queries |
| **Cache / PubSub** | Redis | Event propagation, result caching |
| **Containerisation** | Docker + Docker‑Compose | Development & production orchestration |
| **CI/CD** | GitHub Actions | Linting, unit tests, Docker image publishing |

---  

## Quickstart  

### Prerequisites  

- Node.js **≥18.x**  
- Docker & Docker‑Compose  
- (Optional) PostgreSQL client for manual queries  

### 1. Clone & Install  

```bash
git clone https://github.com/yourorg/anomaly-correlation-api.git
cd anomaly-correlation-api
npm ci               # install dependencies
```

### 2. Run the stack locally  

```bash
docker-compose up -d   # starts PostgreSQL, Redis, and the API container
npm run dev            # starts the TypeScript server in watch mode
```

The API will be reachable at `http://localhost:3000/v1`.

### 3. Ingest a sample metric  

```bash
curl -X POST http