# Real‑Time Anomaly Alerting Service  
*Category: Data Science*  
*Stack: Node.js • TypeScript • Python*  

---  

## Overview  

The **Real‑Time Anomaly Alerting Service** continuously monitors streaming data, detects statistical and machine‑learning‑based anomalies, and pushes alerts to downstream consumers via a RESTful API and a WebSocket channel.  

Key capabilities  

- **Multi‑language core** – heavy‑weight detection models run in Python, while the ingestion, orchestration, and API layers are built with Node.js/TypeScript.  
- **Low‑latency pipeline** – end‑to‑end detection and notification in < 200 ms for typical workloads.  
- **Extensible alerting** – plug‑in adapters for Slack, PagerDuty, custom HTTP hooks, or any WebSocket client.  
- **Scalable architecture** – horizontal scaling of both the Python worker pool and the Node.js gateway.  

---  

## Theory & Architecture  

### 1. Data Flow  

```
[Data Source] → (HTTP / Kafka) → Node.js Ingestor → Queue (Redis) → Python Worker(s) → Anomaly Score → Alert Dispatcher → API / WebSocket
```

1. **Ingestor (Node.js/TS)**  
   - Accepts JSON payloads via `POST /ingest` or reads from a Kafka topic.  
   - Normalises timestamps, validates schema, and pushes raw records onto a Redis stream (`anomaly:raw`).  

2. **Queue (Redis Streams)**  
   - Provides at‑least‑once delivery semantics and back‑pressure handling.  

3. **Python Worker Pool**  
   - Pulls batches from the stream, applies a **Hybrid Detection Engine**:  
     - *Statistical*: Z‑score, EWMA, Seasonal Decomposition.  
     - *ML*: Isolation Forest, LSTM‑based forecasting (optional).  
   - Emits a structured alert (`{id, timestamp, metric, score, severity}`) to `anomaly:alerts`.  

4. **Alert Dispatcher (Node.js)**  
   - Subscribes to `anomaly:alerts`.  
   - Persists alerts in PostgreSQL for audit.  
   - Pushes real‑time notifications:  
     - `POST /alerts/:id` (REST)  
     - Broadcast on WebSocket namespace `/ws/alerts`.  

### 2. Core Algorithms  

| Component | Technique | Why it fits |
|-----------|-----------|-------------|
| **Statistical** | Z‑score, Exponentially Weighted Moving Average (EWMA) | Fast O(1) per point, works for stationary series. |
| **Machine‑Learning** | Isolation Forest (unsupervised) | Detects multivariate outliers without labelled data. |
| **Deep Learning (optional)** | LSTM auto‑encoder | Captures temporal dependencies for complex seasonal patterns. |

### 3. Deployment Diagram  

```
+-------------------+      +-------------------+      +-------------------+
|   Data Sources    | ---> |  Node.js Gateway  | ---> |   Redis Streams   |
+-------------------+      +-------------------+      +-------------------+
                                   |                         |
                                   v                         v
                        +-------------------+      +-------------------+
                        | Python Workers    | ---> | PostgreSQL Store |
                        +-------------------+      +-------------------+
                                   |
                                   v
                        +-------------------+
                        | Alert Dispatcher  |
                        +-------------------+
                                   |
               +-------------------+-------------------+
               |                                       |
        REST API (/alerts)                     WebSocket (/ws/alerts)
```

---  

## Quickstart  

### Prerequisites  

| Tool | Minimum Version |
|------|-----------------|
| Node.js | 18.x |
| npm / yarn | 9.x |
| Python | 3.10 |
| Redis | 6.2 |
| PostgreSQL | 13 |
| Docker (optional) | 24.x |

### 1. Clone the repository  

```bash
git clone https://github.com/yourorg/real-time-anomaly-alert.git
cd real-time-anomaly-alert
```

### 2. Start dependencies with Docker Compose (recommended)

```bash
docker compose up -d redis postgres
```

### 3. Install & build the Node.js gateway  

```bash
cd gateway
npm ci          # or `yarn install`
npm run build   # transpile TypeScript
npm start       # starts API on http://localhost:3000
```

### 4. Install & run the Python workers  

```bash
cd ../workers
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m worker.main   # starts the consumer loop
```

### 5. Send a test event  

```bash
curl -X POST