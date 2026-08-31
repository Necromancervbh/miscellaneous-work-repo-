# Anomaly Detection Aggregator
**Category:** Data Science  
**Stack:** TypeScript / Node.js  

Aggregates multi‑model anomalies via WebSocket and exposes a unified, easy‑to‑consume API for downstream services.

---

## Overview
The **Anomaly Detection Aggregator** is a lightweight Node.js service that:

* Connects to one or more anomaly‑detection models (e.g., statistical, ML, rule‑based) over WebSocket.
* Normalises disparate payloads into a common schema.
* Applies configurable aggregation rules (e.g., majority vote, weighted scoring).
* Publishes the consolidated anomaly stream through a RESTful endpoint and/or a second WebSocket for consumer applications.

Designed for real‑time monitoring pipelines, the aggregator decouples model execution from downstream alerting, enabling rapid experimentation with new detection techniques without touching the consumer code.

---

## Theory / Architecture

```
+-------------------+       WebSocket       +-------------------+
|   Model A (TS)    | <--------------------> |                   |
+-------------------+                        |                   |
                                             |   Aggregator      |
+-------------------+       WebSocket       |   Service         |   HTTP / WS
|   Model B (Python) | <--------------------> |   (Node.js)      | <------------> Clients
+-------------------+                        |                   |
                                             |                   |
+-------------------+       WebSocket       +-------------------+
|   Model C (Java)  | <-------------------->
+-------------------+
```

### Core Components
| Component | Responsibility | Key Types |
|-----------|----------------|-----------|
| **Connector** | Maintains a persistent WebSocket per model, handles reconnection, validates inbound messages. | `ModelConnector` |
| **Normalizer** | Transforms each model’s payload into `UnifiedAnomaly` (timestamp, severity, source, metadata). | `AnomalyNormalizer` |
| **Aggregator** | Merges incoming `UnifiedAnomaly` objects using pluggable strategies (`majority`, `weighted`, `custom`). | `AggregationStrategy` |
| **API Layer** | Exposes `/anomalies` (GET) and `/ws` (WebSocket) endpoints; supports filtering, pagination, and subscription. | `Express`, `ws` |
| **Config Manager** | Loads runtime configuration (model URLs, weights, thresholds) from `config.yaml` or environment variables. | `ConfigService` |

### Data Flow
1. **Connect** – On startup, the service spins up a `ModelConnector` for each configured model URL.
2. **Receive** – Each connector streams JSON messages (`{eventId, score, ...}`) over WebSocket.
3. **Normalize** – The `Normalizer` converts the raw payload into the unified schema.
4. **Queue** – Normalized anomalies are placed on an in‑memory priority queue (ordered by timestamp).
5. **Aggregate** – The `Aggregator` pulls from the queue, applies the chosen strategy, and emits a single `AggregatedAnomaly`.
6. **Publish** – The API layer pushes the aggregated result to connected HTTP clients (poll) or WebSocket subscribers (push).

---

## Quickstart

### Prerequisites
* Node.js ≥ 18
* Yarn or npm
* Access to at least one anomaly‑model WebSocket endpoint (demo URLs are provided in `config.example.yaml`).

### Installation
```bash
# Clone the repo
git clone https://github.com/yourorg/anomaly-detection-aggregator.git
cd anomaly-detection-aggregator

# Install dependencies
yarn install   # or npm ci

# Copy and edit the config
cp config.example.yaml config.yaml
# Edit config.yaml to point to your model WebSocket URLs and set aggregation weights
```

### Running the Service
```bash
# Development mode (auto‑reload)
yarn dev

# Production build & run
yarn build
yarn start
```

The service will listen on **`http://localhost:3000`** by default.

### Example: Consuming the Unified API
```typescript
import axios from 'axios';
import WebSocket from 'ws';

// Pull the latest aggregated anomalies via REST
async function fetchAnomalies() {
  const resp = await axios.get('http://localhost:3000/anomalies?limit=10');
  console.log('Recent anomalies:', resp.data);
}

// Subscribe to real‑time stream via WebSocket
function subscribeRealtime() {
  const ws = new WebSocket('ws://localhost:3000/ws');

  ws.on('open', () => console.log('WebSocket connected'));
  ws.on('message', (data) => {
    const anomaly = JSON.parse(data.toString());
    console.log('Realtime anomaly:', anomaly);
  });
  ws.on('close', () => console.log('WebSocket closed'));
}

// Run both
fetchAnomalies();
subscribeRealtime();
```

### Testing
```bash
# Unit tests
yarn test

# Integration test (requires mock model servers)
yarn test:integration
```

---

## Complexity Analysis

| Aspect | Description | Complexity |
|--------|-------------|------------|
| **WebSocket Management** | Each model connection runs in its