# Anomaly Correlation ML Service  
*Data Science • Node.js / Python*  

A lightweight micro‑service that performs **real‑time anomaly detection** on streaming data and **correlates** detected anomalies across multiple sources. The service exposes a simple HTTP/JSON API (Node.js) that delegates heavy‑lifting to a Python‑based ML engine.

---  

## Overview  

- **Purpose** – Detect outliers in high‑velocity time‑series streams and automatically discover relationships (e.g., causal or co‑occurring patterns) between them.  
- **Target users** – Data engineers, ML Ops teams, and developers building monitoring dashboards, fraud detection pipelines, or IoT analytics platforms.  
- **Key features**  
  - Stateless REST endpoint (`/detect`) for on‑demand scoring.  
  - Batch endpoint (`/correlate`) to compute correlation graphs over a sliding window.  
  - Pluggable models (Isolation Forest, LSTM‑AutoEncoder, etc.).  
  - Docker‑ready, CI‑friendly, and easy to embed in Kubernetes.  

---  

## Theory / Architecture  

```
+----------------+          +----------------+          +-------------------+
|  Data Sources  |  -->  |  Node.js API   |  -->  |  Python ML Engine |
| (Kafka, MQTT, |          | (Express.js)   |          | (FastAPI / gRPC) |
|  HTTP, etc.)   |          +----------------+          +-------------------+
+----------------+                |   ^                         |
                                 |   |                         |
                                 |   |  JSON / protobuf        |
                                 v   |                         v
                         +----------------+          +-------------------+
                         |  Model Store   |          |  Correlation DB  |
                         | (Pickle / ONNX)|          | (Neo4j / Redis) |
                         +----------------+          +-------------------+
```

1. **Ingestion** – Clients POST a JSON payload containing a timestamped feature vector.  
2. **API Layer (Node.js)** – Validates input, throttles requests, and forwards the payload to the Python engine via **gRPC** (low latency) or a **child process** (fallback).  
3. **ML Engine (Python)** –  
   - **Anomaly detection**: Uses an unsupervised model (Isolation Forest by default).  
   - **Scoring**: Returns an anomaly score ∈ [0, 1] and a binary flag.  
   - **Correlation**: Stores each flagged event in a time‑indexed store; periodically runs a **pairwise Pearson / Dynamic Time Warping** similarity across the window to emit edges in a correlation graph.  
4. **Persistence** – Detected anomalies are written to a time‑series DB (e.g., InfluxDB) for audit; correlation edges are persisted in a graph DB for downstream queries.  
5. **Response** – Node.js returns a concise JSON response (`{score, is_anomaly, correlated_ids}`) to the caller.  

---  

## Quickstart  

### Prerequisites  

| Tool | Minimum version |
|------|-----------------|
| Node.js | 18.x |
| Python | 3.10 |
| Docker (optional) | 20.10 |
| gRPC tools | `npm i -g grpc-tools` |

### 1. Clone the repository  

```bash
git clone https://github.com/yourorg/anomaly-correlation-ml-service.git
cd anomaly-correlation-ml-service
```

### 2. Install dependencies  

```bash
# Node.js side
npm ci

# Python side (virtualenv recommended)
python -m venv .venv
source .venv/bin/activate
pip install -r python/requirements.txt
```

### 3. Start the services  

#### Option A – Local (development)  

```bash
# Terminal 1 – Python model server
cd python
uvicorn ml_server:app --host 0.0.0.0 --port 8000

# Terminal 2 – Node.js API
cd ../node
npm start   # runs src/server.js
```

#### Option B – Docker (single command)  

```bash
docker compose up --build
```

The API will be reachable at **http://localhost:3000** and the ML engine at **http://localhost:8000** (internal only).