# Anomaly Correlation Analytics Service
**Category:** Data Science  
**Stack:** Node.js • TypeScript • Python  
**Description:** Aggregates, scores, and visualizes anomaly insights.

---

## Overview
The **Anomaly Correlation Analytics Service** (ACAS) is a lightweight, extensible platform for turning raw anomaly detections into actionable insights. It:

* **Aggregates** anomaly events from multiple sources (e.g., monitoring agents, batch jobs, streaming pipelines).  
* **Scores** each event using a configurable correlation model that accounts for temporal proximity, feature similarity, and domain‑specific weights.  
* **Visualizes** the resulting correlation graph and heat‑maps through a built‑in dashboard or via export to popular BI tools.

Designed for data‑science teams that need a reproducible, programmatic way to understand why anomalies happen together, ACAS can be embedded in existing Node.js services or called from Python notebooks for ad‑hoc analysis.

---

## Theory & Architecture
### 1. Data Ingestion
* **Adapters** (Node.js/TS) expose a RESTful `/ingest` endpoint and a Python client library (`acascientist`).  
* Incoming payloads are normalized to a canonical schema:  

```json
{
  "id": "string",
  "timestamp": "ISO8601",
  "features": { "key": "value", ... },
  "severity": "float",
  "source": "string"
}
```

### 2. Storage Layer
* **Time‑Series Store** – In‑memory Redis for recent events (default 24 h).  
* **Persistent Store** – PostgreSQL (JSONB column) for long‑term archival and query‑by‑feature.

### 3. Correlation Engine (Python)
* Implemented as a **scikit‑learn** pipeline:
  * **Feature Embedding** – `StandardScaler` + optional `PCA`.
  * **Distance Metric** – Euclidean for numeric, Hamming for categorical, combined via weighted sum.
  * **Temporal Decay** – Exponential decay factor `e^{‑λΔt}`.
* **Score Function**  

\[
\text{score}(a_i, a_j) = w_f \cdot \text{sim}_f(a_i, a_j) + w_t \cdot e^{-\lambda |t_i - t_j|}
\]

where:
* \(w_f, w_t\) are configurable weights,
* \(\text{sim}_f\) is the feature similarity,
* \(\lambda\) controls temporal sensitivity.

### 4. API Layer (Node.js/TS)
* **GET `/correlations?start=&end=&threshold=`** – Returns a list of anomaly pairs with scores above `threshold`.  
* **GET `/graph?eventId=`** – Returns a sub‑graph (nodes & edges) centered on a specific anomaly.  
* **WebSocket `/live`** – Streams real‑time correlation updates to dashboards.

### 5. Visualization
* **Built‑in Dashboard** (React + D3) served via Express.  
* **Export** – CSV, JSON, or GraphML for external tools.

### 6. Extensibility
* **Plugin System** – Add custom similarity functions or data sources by implementing the `IAnomalyAdapter` interface (TypeScript) or `AnomalyScorer` subclass (Python).  

---

## Quickstart
Below is a minimal end‑to‑end example that:

1. Starts the service (Docker‑compose).  
2. Sends a few anomaly events from a TypeScript client.  
3. Queries the correlation scores from a Python notebook.

### 1. Run the service
```bash
# Clone the repo
git clone https://github.com/yourorg/anomaly-correlation-analytics-service.git
cd anomaly-correlation-analytics-service

# Start with Docker Compose (includes Redis & PostgreSQL)
docker compose up -d
```

### 2. Install client libraries
```bash
# Node.js/TypeScript client
npm install @acascientist/client

# Python client (optional, for notebooks)
pip install acascientist
```

### 3. Ingest anomalies (TypeScript)
```ts
import { AnomalyClient } from '@acascientist/client';

const client = new AnomalyClient({ baseURL: 'http://localhost:3000' });

async function sendSample() {
  const anomalies = [
    {
      id: 'a1',
      timestamp: new Date().toISOString(),
      features: { cpu: 92, region: 'us-east-1' },
      severity: 0.87,
      source: 'host-01'
    },
    {
      id: 'a2',
      timestamp: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      features: { cpu: 95, region: 'us-east-1' },
      severity: 0.91,
      source: 'host-02'
    }
  ];

  for (const ev of anomalies) {
    await client.ingest(ev);
    console.log(`Ingested ${ev.id}`);
  }
}

sendSample().catch(console.error);
```

### 4. Query correlations (Python)
```python
from acasc