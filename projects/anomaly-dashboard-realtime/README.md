# Real-Time Anomaly Dashboard  

**Category:** Full‑Stack  
**Stack:** Node.js, TypeScript, WebSocket, Redis  

A live web UI that streams anomaly scores from a backend service, enriches each event with explainability data, and visualises the results in real time.

---  

## Overview  

The Real‑Time Anomaly Dashboard provides a complete end‑to‑end solution for monitoring streaming data pipelines:

- **Live scoring:** Anomaly scores are pushed to the UI as soon as they are computed.  
- **Explainability:** Each score is accompanied by feature‑level contributions, enabling rapid root‑cause analysis.  
- **Scalable back‑end:** Uses Redis Pub/Sub for low‑latency message distribution and a WebSocket server for efficient client broadcasting.  
- **Typed throughout:** TypeScript guarantees type safety on both server and client sides.  

Typical use‑cases include fraud detection, IoT sensor health monitoring, and any scenario where instant feedback on abnormal behaviour is required.

---  

## Theory / Architecture  

```
+-------------------+          +-------------------+          +-------------------+
|   Data Source(s)  |  --->    |  Anomaly Engine   |  --->    |   Redis Pub/Sub   |
| (Kafka, MQTT…)   |          | (Python/TS model) |          |   (scores +      |
+-------------------+          +-------------------+          |   explanations) |
                                                             +-------------------+
                                                                     |
                                                                     v
+-------------------+          +-------------------+          +-------------------+
|   Node.js Server  |  <---   |   Redis Subscriber|  <---   |   Redis Publisher |
| (WebSocket API)   |          |   (TS worker)    |          |   (scores)        |
+-------------------+          +-------------------+          +-------------------+
          |                                 |
          | WebSocket (ws://)               | Broadcast
          v                                 v
+---------------------------------------------------------------+
|                     Front‑end (React/TS)                     |
|   • Receives live messages via WebSocket                      |
|   • Renders score timeline, heat‑maps, and feature bars       |
|   • Allows drill‑down into explainability data                |
+---------------------------------------------------------------+
```

### Key Components  

| Component | Responsibility | Tech |
|-----------|----------------|------|
| **Anomaly Engine** | Generates a numeric anomaly score and a per‑feature contribution vector for each incoming event. | Python/TS, TensorFlow, SHAP, etc. |
| **Redis Pub/Sub** | Decouples the scoring service from the WebSocket server; provides at‑least‑once delivery with sub‑millisecond latency. | Redis 7.x |
| **Node.js WebSocket Server** | Subscribes to Redis channels, transforms messages into a compact JSON payload, and pushes them to all connected browsers. | `ws` library, TypeScript |
| **Front‑end UI** | Renders a real‑time dashboard, supports filtering, and visualises explainability. | React + TypeScript, Chart.js / D3 |
| **Type Definitions** | Shared `.d.ts` files ensure both server and client interpret the payload identically. | TypeScript |

### Data Flow  

1. **Ingestion** – Raw events arrive at the anomaly engine.  
2. **Scoring** – The engine emits `{ id, timestamp, score, explanation }`.  
3. **Publish** – The JSON payload is published to Redis channel `anomaly:scores`.  
4. **Subscribe** – The Node.js worker subscribes, validates the payload, and forwards it via WebSocket.  
5. **Render** – The browser receives the message and updates the visualisation instantly.

---  

## Quickstart  

> **Prerequisites**  
> - Node.js ≥ 18  
> - Yarn or npm  
> - Docker (for Redis)  
> - (Optional) Python environment if you want to run the sample anomaly engine  

### 1. Clone the repository  

```bash
git clone https://github.com/yourorg/real-time-anomaly-dashboard.git
cd real-time-anomaly-dashboard
```

### 2. Install dependencies  

```bash
# Using Yarn
yarn install

# Or with npm
npm ci
```

### 3. Start Redis (Docker)  

```bash
docker run -d --name rta-redis -p 6379:6379 redis:7-alpine
```

### 4. Run the back‑end (WebSocket server)  

```bash
# Compile TypeScript and start the server
y