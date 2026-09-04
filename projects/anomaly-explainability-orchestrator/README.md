# Anomaly Explainability Orchestrator  
**Category:** Data Science  
**Stack:** Node.js / TypeScript  

---  

## Overview  

The **Anomaly Explainability Orchestrator** (AEO) provides a single, cohesive RESTful API that brings together three core anomaly‑analysis capabilities:

| Capability | What it does | Why it matters |
|------------|--------------|----------------|
| **Detection** | Identifies outliers in streaming or batch data using configurable statistical or machine‑learning detectors. | Early warning for faults, fraud, or operational issues. |
| **Clustering** | Groups detected anomalies into semantically meaningful clusters (e.g., DBSCAN, K‑Means, hierarchical). | Reduces alert fatigue and surfaces common root causes. |
| **Bayesian Scoring** | Assigns a probabilistic confidence score to each anomaly based on prior knowledge and observed evidence. | Enables risk‑based prioritisation and decision making. |

AEO abstracts the orchestration logic, letting data‑science teams focus on model tuning while developers consume a clean, versioned HTTP interface.

---  

## Theory & Architecture  

### 1. High‑level Flow  

```
Client Request → API Gateway → Orchestrator Core → ├─ Detector Service
                                                    ├─ Clustering Service
                                                    └─ Bayesian Scorer
                                                    
Responses from services → Result Aggregator → Unified JSON Response
```

### 2. Core Components  

| Component | Responsibility | Implementation Highlights |
|-----------|----------------|----------------------------|
| **API Gateway** | Express.js server with OpenAPI‑generated routes. | Type‑safe request validation via `zod`. |
| **Orchestrator Core** | Coordinates sub‑services, handles retries, and merges results. | Uses `async/await` with `Promise.allSettled` to tolerate partial failures. |
| **Detector Service** | Executes one or more detection algorithms (e.g., Isolation Forest, Z‑Score). | Pluggable via the `IDetector` interface; new detectors added without core changes. |
| **Clustering Service** | Takes raw anomaly points and produces cluster labels. | Supports dynamic selection of clustering algorithm based on data dimensionality. |
| **Bayesian Scorer** | Computes posterior probabilities \( P(\text{anomaly} \mid \text{evidence}) \). | Prior distributions are configurable per data source; uses `bayesjs` under the hood. |
| **Result Aggregator** | Normalises outputs, adds metadata (timestamp, request ID), and formats the final payload. | Guarantees a stable schema (`/v1/anomalies`). |

### 3. Data Model  

```ts
interface Anomaly {
  id: string;                     // UUID
  timestamp: string;              // ISO‑8601
  rawScore: number;               // Detector output
  clusterId?: string;             // Assigned by clustering step
  bayesianScore: number;          // Posterior probability
  metadata?: Record<string, any>; // Optional user‑defined fields
}
```

### 4. Extensibility  

* **Plugin Architecture** – New detectors, clustering algorithms, or scoring models are discovered via the `plugins/` directory and registered at runtime.  
* **Configuration‑Driven** – All thresholds, priors, and algorithm hyper‑parameters live in a single `config.yaml`, allowing environment‑specific overrides without code changes.  

---  

## Quickstart  

### Prerequisites  

* Node.js **≥ 18**  
* Yarn or npm  
* Docker (optional, for running the bundled PostgreSQL sandbox)  

### 1. Clone & Install  

```bash
git clone https://github.com/yourorg/anomaly-explainability-orchestrator.git
cd anomaly-explainability-orchestrator
yarn install   # or npm ci
```

### 2. Run the service (development mode)  

```bash
# Load default configuration and start the Express server
yarn dev
# Server starts on http://localhost:3000
```

### 3. Call the unified endpoint  

```ts
import axios from 'axios';

async function runExample() {
  const payload = {
    data: [
      { timestamp: '2026-09-04T12:00:00Z', value: 42 },
      { timestamp: '2026-09-04T12:01:00Z', value: 3 },
      // … more points …
    ],
    options: {
      detector: 'zscore',
      clustering: 'dbscan',
      priorAnomalyProb: 0.01
    }
  };

  try {
    const response = await axios.post('http://localhost:3000/v1/anomalies', payload);
    console.log('Unified response:', response.data);
  } catch (err) {
    console.error('Request failed:', err);
  }
}

runExample();
```

**Sample unified JSON response**

```json
{
  "requestId": "c3f9e8a2-7b1d-4f6a-9d2e-5f8b2c1a9d3e",
  "generatedAt