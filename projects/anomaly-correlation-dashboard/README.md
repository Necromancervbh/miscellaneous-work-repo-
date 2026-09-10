# Anomaly Correlation Dashboard  

**Category:** Full‑Stack | **Stack:** Node.js • React • TypeScript  

A web UI that aggregates multiple anomaly streams, visualizes them in real time, and pushes live alerts to operators. The dashboard correlates disparate signals, highlights overlapping events, and provides drill‑down details for rapid incident response.

---  

## Overview  

The **Anomaly Correlation Dashboard** is a single‑page application (SPA) backed by a Node.js server that:

* **Ingests** JSON‑encoded anomaly events from one or more upstream services via WebSocket or HTTP POST.  
* **Normalizes** and stores events in an in‑memory time‑series store (Redis) for low‑latency queries.  
* **Correlates** events across streams using configurable temporal and semantic rules (e.g., “same host + < 5 min”).  
* **Pushes** live alerts to connected browsers through Socket.io, updating charts and tables instantly.  
* **Provides** a React/TS UI with filtering, timeline navigation, and detailed view panels.

The project is deliberately modular so you can swap out the data source, correlation engine, or UI components without touching the rest of the codebase.

---  

## Theory / Architecture  

```
+-------------------+        +-------------------+        +-------------------+
|  Anomaly Sources  |  --->  |   Ingestion API   |  --->  |   Correlation DB  |
| (Kafka, HTTP, WS) |        |   (Node.js/TS)    |        |   (Redis)         |
+-------------------+        +-------------------+        +-------------------+
                                   |                               |
                                   |   Socket.io (push)            |
                                   v                               v
                           +-------------------+        +-------------------+
                           |   Alert Service   |  --->  |   React Front‑End |
                           | (Node.js/TS)      |        | (TypeScript)      |
                           +-------------------+        +-------------------+
```

### Core Components  

| Component | Responsibility | Tech |
|-----------|----------------|------|
| **Ingestion API** | Receives raw anomaly events, validates schema, timestamps, and writes to Redis. | Express + TypeScript |
| **Correlation Engine** | Runs periodic jobs (or event‑driven triggers) that apply rule sets to find overlapping anomalies. Generates alert objects. | Node.js worker, `bullmq` queue |
| **Alert Service** | Publishes alerts to all connected clients via Socket.io, persists recent alerts for history view. | Socket.io, Redis Pub/Sub |
| **React UI** | Subscribes to alert stream, renders time‑series charts (Recharts), tables, and a map view. Supports user‑defined filters. | React 18, TypeScript, Zustand (state) |
| **Persistence Layer** | Optional PostgreSQL store for long‑term audit logs and user preferences. | Prisma ORM |

### Data Flow  

1. **Event Ingestion** – External system POSTs `/api/events` or opens a WS connection. The server validates and stores the event in a sorted set keyed by timestamp.  
2. **Correlation Trigger** – A worker reads the newest events, groups them by configurable keys (e.g., `hostId`, `serviceId`), and checks temporal overlap.  
3. **Alert Generation** – When a rule matches, an alert object is created and pushed to Redis Pub/Sub.  
4. **Client Update** – All browsers subscribed to `alerts` receive the payload instantly, causing UI components to re‑render.  

---  

## Quickstart  

> **Prerequisites**  
> - Node.js ≥ 18  
> - Yarn (or npm)  
> - Redis server running locally on default port (6379)  

```bash
# 1️⃣ Clone the repo
git clone https://github.com/your-org/anomaly-correlation-dashboard.git
cd anomaly-correlation-dashboard

# 2️⃣ Install dependencies (both server & client)
yarn install          # installs root workspace packages
yarn workspace server install
yarn workspace client install

# 3️⃣ Start Redis (Docker example)
docker run -d --name redis -p 6379:6379 redis:7-alpine

# 4️⃣ Build & run the backend
yarn workspace server dev   # runs src/server.ts with ts-node-dev

# 5️⃣ In a new terminal, launch the React front‑end
yarn workspace client start

# 6️⃣ Send a test anomaly event
curl -X POST http://localhost:4000/api/events \
  -H "Content-Type: application/json" \
  -d '{
        "source": "sensor-A",
        "hostId": "host-123",
        "metric": "cpu_load",
        "value": 92.5,
        "timestamp": "$(date +%s%3N)"
      }'

# Open http://localhost:3000 in your browser – you should see the event appear
# in the live feed and, if it matches a correlation rule, an alert badge will pop up.
```

### Project Structure  

```
/root
│
├