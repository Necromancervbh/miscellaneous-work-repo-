# Anomaly Insights Aggregator
**Category:** Data Science  
**Stack:** TypeScript / Node.js  

Aggregates multi‑source anomaly data, applies Principal Component Analysis (PCA), clustering, and Bayesian scoring to deliver unified, actionable insights.

---  

## Overview
The **Anomaly Insights Aggregator** is a Node.js library that:

- **Ingests** anomaly streams from heterogeneous sources (logs, metrics, events, etc.).
- **Normalises** and aligns data into a common feature space.
- **Reduces dimensionality** with PCA to highlight the most informative components.
- **Groups** similar anomalies using configurable clustering algorithms (K‑Means, DBSCAN, etc.).
- **Ranks** clusters via a Bayesian scoring model that incorporates prior knowledge and confidence levels.
- **Exports** a concise report (JSON/CSV) or streams results to downstream services.

Designed for data‑science teams that need a single source of truth for anomaly detection across complex systems.

---  

## Theory & Architecture  

### 1. Data Ingestion & Normalisation  
| Step | Description |
|------|-------------|
| **Source Connectors** | Plug‑in adapters for REST, Kafka, file‑based logs, Prometheus, etc. |
| **Schema Mapping** | User‑defined mapping tables translate source fields to a canonical schema (`timestamp`, `entityId`, `metricVector`). |
| **Missing‑Value Handling** | Imputation (mean/median) or forward‑fill based on configurable policies. |
| **Scaling** | Standardisation (zero‑mean, unit‑variance) or min‑max scaling per feature. |

### 2. Dimensionality Reduction – PCA  
- **Goal:** Capture the majority of variance while discarding noise.  
- **Implementation:** Incremental SVD (via `ml-matrix`) to handle streaming data.  
- **Parameters:** `nComponents` (default 0.95 variance retention) or explicit component count.

### 3. Clustering  
- **Algorithms Supported:**  
  - **K‑Means** (Lloyd’s algorithm) – fast, works well on spherical clusters.  
  - **DBSCAN** – density‑based, discovers arbitrarily shaped clusters & outliers.  
- **Selection:** Auto‑tune via silhouette score or user‑provided config.  

### 4. Bayesian Scoring  
- **Model:**  
  \[
  P(C_i \mid D) \propto P(D \mid C_i) \cdot P(C_i)
  \]
  where `C_i` is a cluster, `D` the observed data.  
- **Likelihood (`P(D|C_i)`):** Multivariate Gaussian fitted on PCA‑projected points of the cluster.  
- **Prior (`P(C_i)`):** User‑defined (e.g., business impact, historical frequency).  
- **Posterior:** Normalised score ∈ [0,1] used to rank clusters.

### 5. Output & Integration  
- **Report Formats:** JSON, CSV, or NDJSON streams.  
- **Hooks:** Webhook, HTTP POST, or direct write to a data lake (S3, GCS).  

---  

## Quickstart  

### Prerequisites
```bash
# Node.js 18+ and npm
node -v   # >= 18
npm -v
```

### Installation
```bash
npm install anomaly-insights-aggregator
```

### Basic Usage
```typescript
import { Aggregator, SourceConfig, PCAConfig, ClusterConfig, BayesianConfig } from 'anomaly-insights-aggregator';

// 1️⃣ Define source connectors
const sources: SourceConfig[] = [
  {
    name: 'app-logs',
    type: 'kafka',
    topic: 'app.anomalies',
    schemaMap: {
      ts: 'timestamp',
      id: 'entityId',
      payload: 'metricVector'
    }
  },
  {
    name: 'metrics',
    type: 'rest',
    endpoint: 'https://metrics.example.com/api/anomalies',
    schemaMap: { /* ... */ }
  }
];

// 2️⃣ Configure processing steps
const pcaCfg: PCAConfig = { varianceRetained: 0.96 };
const clusterCfg: ClusterConfig = { algorithm: 'dbscan', eps: 0.5, minPoints: 5 };
const bayesCfg: BayesianConfig = {
  priors: { /* clusterId -> prior probability */ },
  confidence: 0.9
};

// 3️⃣ Create and run the aggregator
(async () => {
  const agg = new Aggregator({
    sources,
    pca: pcaCfg,
    clustering: clusterCfg,
    scoring: bayesCfg,
    output: { format: 'json', destination: './reports/insights.json' }
  });

  // Starts ingestion, processing, and writes