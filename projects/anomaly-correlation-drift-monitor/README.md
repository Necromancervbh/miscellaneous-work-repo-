# Concept Drift Monitoring Service  

**Category:** Data Science  
**Stack:** Node.js / TypeScript  

---  

## Overview  

Model performance can degrade over time as the underlying data distribution shifts—a phenomenon known as **concept drift**. The Concept Drift Monitoring Service continuously watches incoming data streams, quantifies distribution changes with **Kullback‑Leibler (KL) divergence**, and captures structural shifts using **incremental Principal Component Analysis (IPCA)**. When drift exceeds configurable thresholds, the service emits alerts so data scientists can retrain or replace models before predictive quality suffers.  

Key features  

- Real‑time drift detection on high‑throughput streams.  
- Stateless micro‑service with a thin REST/gRPC API.  
- Plug‑and‑play metric adapters (KL divergence, IPCA, custom).  
- Configurable alert channels (Slack, email, webhook).  
- Extensible TypeScript codebase with full test coverage.  

---  

## Theory / Architecture  

### 1. Drift Metrics  

| Metric | Purpose | Core Formula |
|--------|---------|--------------|
| **KL Divergence** | Measures how the probability distribution of a new batch diverges from a reference distribution. | ![KL(p‖q)=∑p(x)log(p(x)/q(x))] |
| **Incremental PCA** | Tracks changes in the covariance structure of the feature space without recomputing a full PCA. | Updates eigenvectors `U_k` and eigenvalues `λ_k` incrementally as new samples arrive. |

Both metrics are computed on a **sliding window** of the most recent `N` samples (default `N = 10,000`).  

### 2. Service Components  

```
┌─────────────────────┐
│  HTTP/gRPC Endpoint │
└───────┬─────────────┘
        │
┌───────▼─────────────┐
│   Ingestion Layer   │   ← validates payload, timestamps
└───────┬─────────────┘
        │
┌───────▼─────────────┐
│   Window Manager    │   ← maintains circular buffers per feature
└───────┬─────────────┘
        │
┌───────▼─────────────┐
│   Metric Engine     │   ← KL & IPCA calculators (streaming)
└───────┬─────────────┘
        │
┌───────▼─────────────┐
│   Alert Dispatcher  │   ← threshold check → Slack / Email / Webhook
└─────────────────────┘
```

- **Ingestion Layer** receives JSON payloads `{ timestamp, features: number[] }`.  
- **Window Manager** stores the last `N` rows per feature in a memory‑efficient ring buffer.  
- **Metric Engine** updates the reference distribution (initial batch) and computes KL divergence on each new window. Simultaneously, IPCA updates eigenvectors to detect subspace drift.  
- **Alert Dispatcher** compares metric values against user‑defined thresholds (`klThreshold`, `pcaExplainedVarianceDrop`) and pushes notifications.  

### 3. Data Flow  

1. **Bootstrapping** – The first `N` samples initialize the reference distribution (`p_ref`) and the IPCA model (`U_0`).  
2. **Streaming** – For each incoming sample:  
   - Append to the sliding window.  
   - Re‑estimate the empirical distribution `p_curr`.  
   - Compute `KL(p_curr‖p_ref)`.  
   - Perform an IPCA update step.  
   - If `KL > klThreshold` **or** `explainedVarianceDrop > pcaThreshold`, trigger an alert.  

---  

## Quickstart  

### Prerequisites  

- Node.js ≥ 18  
- Yarn or npm  
- (Optional) Docker for containerised deployment  

### Installation  

```bash
# Clone the repo
git clone https://github.com/yourorg/concept-drift-monitor.git
cd concept-drift-monitor

# Install dependencies
yarn install   # or npm ci
```

### Running locally  

```bash
# Build TypeScript sources
yarn build

# Start the service (default port 8080)
yarn start
```

The service now listens on `http://localhost:8080/api/v1/ingest`.  

### Sending data (example)  

```ts
import axios from 'axios';

// Simulated feature vector generator
function generateSample(): number[] {
  // Example: 5‑dimensional Gaussian with a slow drift on the 3rd dim
  const base = [0, 0, 0, 0, 0];
  const drift = Math.random() * 0.01; // tiny drift per call
  base[2] += drift;
  return base.map(v => v + Math.random() * 0.1);
}

async function streamSamples(count: number) {
  for (let i = 0; i < count; i++) {
    const payload = {
      timestamp: new Date().toISOString(),
      features: generateSample(),
    };
    await axios.post('http://localhost:8080/api/v1/ingest', payload);
    // simulate real‑time pacing
    await new