# Real‑Time Anomaly Detection Dashboard  

**Category:** Data Science  
**Stack:** TypeScript • Node.js • React  

Unified UI for streaming anomaly detection and analytics. Visualize, explore, and act on anomalies as they happen across any data source.

---  

## Overview  

The **Real‑Time Anomaly Detection Dashboard** is a full‑stack web application that:

* **Ingests** high‑velocity data streams via WebSockets or Kafka connectors.  
* **Applies** configurable anomaly detection algorithms (e.g., statistical thresholds, isolation forest, LSTM‑based models) in a Node.js microservice.  
* **Pushes** detection results to a React front‑end in near‑real time.  
* **Provides** interactive charts, drill‑down tables, and alerting hooks (email, Slack, webhook).  

Designed for data scientists and ops teams that need a single pane of glass for monitoring model health, sensor networks, financial tick data, or any streaming KPI.

---  

## Theory & Architecture  

```
+-------------------+        +-------------------+        +-------------------+
|  Data Sources     |  -->   |  Ingestion Service|  -->   |  Detection Engine |
| (Kafka, MQTT, …) |        |  (Node.js WS/HTTP)|        |  (TS/Node)        |
+-------------------+        +-------------------+        +-------------------+
                                   |                               |
                                   v                               v
                         +-------------------+          +-------------------+
                         |  Event Bus (Redis|          |  Model Store      |
                         |   Pub/Sub)       |          |  (MongoDB)        |
                         +-------------------+          +-------------------+
                                   |                               |
                                   v                               v
                         +-------------------+          +-------------------+
                         |  API Gateway      |  <--->   |  Front‑end (React)|
                         |  (Express/TS)    |          |  (TSX)            |
                         +-------------------+          +-------------------+
```

### Core Components  

| Component | Responsibility | Tech |
|-----------|----------------|------|
| **Ingestion Service** | Connects to external streams, normalises payloads, publishes to Redis Pub/Sub. | Node.js, `ws`, `kafka-node` |
| **Detection Engine** | Runs selected anomaly algorithms on sliding windows; emits `{timestamp, metric, score, isAnomaly}` events. | TypeScript, `tfjs`, `isolation-forest`, custom statistical modules |
| **Model Store** | Persists trained models, hyper‑parameters, and historical scores for audit. | MongoDB, Mongoose |
| **API Gateway** | Authenticated REST/GraphQL endpoints for UI, model management, and alert configuration. | Express, TypeScript, JWT |
| **Front‑end Dashboard** | Real‑time charts (Recharts, D3), anomaly tables, filter panels, and alert rule editor. | React, TypeScript, Redux Toolkit, Socket.io client |

### Data Flow  

1. **Source → Ingestion** – Raw events are deserialized, enriched with metadata, and placed on a Redis channel (`raw-events`).  
2. **Ingestion → Detection** – The engine subscribes, buffers a configurable window (e.g., 5 min), computes anomaly scores, and publishes to `anomaly-events`.  
3. **Detection → UI** – The API Gateway forwards `anomaly-events` via Socket.io to connected React clients.  
4. **UI → Alert Service** – When a user‑defined rule fires, the backend triggers external notifications.

---  

## Quickstart  

### Prerequisites  

* Node.js ≥ 18  
* Yarn or npm  
* Docker (for Redis & MongoDB)  

### 1. Clone & Install  

```bash
git clone https://github.com/yourorg/rt-anomaly-dashboard.git
cd rt-anomaly-dashboard
yarn install   # or npm ci
```

### 2. Spin up supporting services  

```bash
docker compose up -d   # launches redis:6 and mongo:6
```

### 3. Build & Run the backend  

```bash
# From the project root
yarn workspace @rt-anomaly/backend build
yarn workspace @rt-anomaly/backend start
```

The API will be available at `http://localhost:4000`.

### 4. Run the front‑end  

```bash
yarn workspace @rt-anomaly/web start
```

Open `http://localhost:3000` in a browser. You should see the dashboard loading with a “Live Stream” placeholder.

### 5. Simulate a data stream (optional)  

```typescript
// src/simulator.ts
import { io } from "socket.io-client";

const socket =