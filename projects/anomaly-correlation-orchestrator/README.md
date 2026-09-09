# Anomaly Correlation Orchestrator  

**Category:** Full‑Stack / Backend  
**Stack:** Node.js • TypeScript  

Orchestrates cross‑project anomaly analysis with async queues, distributed caching, and pluggable correlation strategies.

---  

## Overview  

The **Anomaly Correlation Orchestrator** (ACO) is a lightweight, opinionated service that coordinates the detection, enrichment, and correlation of anomalies across multiple data sources and projects.  

* **Async pipelines** – built on `BullMQ` (Redis‑backed) to guarantee at‑least‑once processing while keeping throughput high.  
* **Smart caching** – a Redis cache layer stores intermediate results (e.g., feature vectors, similarity scores) to avoid recomputation.  
* **Pluggable strategies** – correlation algorithms (cosine similarity, DBSCAN, custom ML models) are injected via a simple TypeScript interface.  
* **Observability** – built‑in metrics (Prometheus), structured logs (pino), and tracing (OpenTelemetry).  

The orchestrator is deliberately framework‑agnostic: it can be run as a standalone microservice, embedded in a larger monolith, or deployed as a serverless function (with minor adapters).

---  

## Theory / Architecture  

```
+-------------------+        +-------------------+        +-------------------+
|   Ingestion API   |  -->   |   Queue Manager   |  -->   |   Worker Pool     |
| (REST / gRPC)     |        | (BullMQ)          |        | (TS Workers)      |
+-------------------+        +-------------------+        +-------------------+
                                   |                         |
                                   |                         |
                                   v                         v
                         +-------------------+   +-------------------+
                         |   Cache Layer     |   |   Correlation     |
                         |   (Redis)         |   |   Engine          |
                         +-------------------+   +-------------------+
                                   |                         |
                                   |                         |
                                   v                         v
                         +-------------------+   +-------------------+
                         |   Persistence     |   |   Notification    |
                         |   (Postgres)      |   |   Service (Kafka) |
                         +-------------------+   +-------------------+
```

### Core Components  

| Component | Responsibility | Key Tech |
|-----------|----------------|----------|
| **Ingestion API** | Accepts raw anomaly events (JSON) from any producer. Performs lightweight validation and pushes a job to the queue. | `express` / `fastify`, `zod` |
| **Queue Manager** | Manages a priority queue per project. Guarantees ordering where needed and supports back‑pressure. | `BullMQ` + Redis |
| **Worker Pool** | Pulls jobs, fetches cached data, runs the selected correlation strategy, writes results. | Node.js worker threads, `pino` |
| **Cache Layer** | Stores pre‑computed feature vectors, similarity matrices, and throttles duplicate work. | Redis (TTL, LRU) |
| **Correlation Engine** | Abstract interface `ICorrelationStrategy`. Implementations may be pure‑TS (cosine similarity) or call out to external ML services. | TypeScript, optional Python gRPC bridge |
| **Persistence** | Stores final correlation outcomes for audit and downstream analytics. | PostgreSQL (typeorm) |
| **Notification Service** | Publishes events (e.g., “high‑severity correlation detected”) to downstream pipelines. | Kafka producer |

### Data Flow  

1. **Event ingestion** – Producer POST `/api/v1/anomalies`. Payload validated → job enqueued.  
2. **Queue dispatch** – Workers fetch jobs, check cache for existing feature vectors.  
3. **Enrichment** – If missing, compute vector (e.g., time‑series embedding) and cache it.  
4. **Correlation** – Run the configured strategy against vectors from the same time window across projects.  
5. **Persist & Notify** – Store correlation record, emit a Kafka message, and optionally trigger alerts.  

---  

## Quickstart  

### Prerequisites  

* Node.js >= 18  
* Docker (for Redis & PostgreSQL)  
* Yarn or npm  

### Install  

```bash
# Clone the repo
git clone https://github.com/your-org/anomaly-correlation-orchestrator.git
cd anomaly-correlation-orchestrator

# Install dependencies
yarn install   # or npm ci

# Build TypeScript
yarn build
```

### Run the supporting services (Redis & PostgreSQL)  

```bash
docker compose up -d
```

### Start the orchestrator  

```bash
# Development mode (watch + hot‑reload)
yarn dev

# Production mode
yarn start
```

The API will be available at `http://localhost:3000`.

### Minimal code example  

```ts
import axios from 'axios';

// Example anomaly payload
const anomaly = {
  projectId: 'proj-42',
  timestamp: Date.now(),
  metric: 'cpu_usage',
  value: 97.3,
  tags