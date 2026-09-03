# Anomaly Explainability API  
**Category:** Data Science | **Stack:** Node.js / TypeScript  

An API that delivers Bayesian explanation scores for detected anomalies, helping data scientists and engineers understand *why* an anomaly occurred rather than just that it occurred.

---  

## Overview  

Modern monitoring pipelines generate thousands of alerts daily, but most systems stop at detection. The **Anomaly Explainability API** bridges that gap by:

* Accepting raw anomaly events (timestamp, metric, value, context).  
* Computing a **Bayesian explanation score** that quantifies the contribution of each feature to the anomaly.  
* Returning a ranked list of explanatory factors with confidence intervals.  

The service is stateless, container‑friendly, and can be integrated into any Node.js / TypeScript stack with a single HTTP call.

---  

## Theory & Architecture  

### Bayesian Explanation Model  

1. **Prior Distribution** – For each feature \(X_i\) we maintain a conjugate prior (e.g., Normal‑Inverse‑Gamma for continuous variables) learned from historical data.  
2. **Likelihood** – When a new observation \(\mathbf{x} = (x_1, …, x_n)\) arrives, we compute the likelihood \(P(\mathbf{x}\mid \theta)\) under the current posterior.  
3. **Posterior Update** – The prior is updated with the new observation, yielding a posterior \(P(\theta\mid \mathbf{x})\).  
4. **Explanation Score** – For each feature we calculate the **Bayes factor**  

\[
S_i = \frac{P(x_i \mid \text{anomaly})}{P(x_i \mid \text{normal})}
\]

   where the “anomaly” hypothesis uses the posterior after the event, and the “normal” hypothesis uses the prior.  
5. **Ranking** – Features are sorted by \(|\log S_i|\); larger absolute values indicate stronger evidence that the feature contributed to the anomaly.

### System Architecture  

```
+-------------------+      HTTP/JSON      +-------------------+
|  Client / Front‑  |  -----------------> |  API Gateway      |
|  end (TS/JS)      |                     |  (Express)        |
+-------------------+                     +-------------------+
                                                |
                                                v
                                         +-------------------+
                                         |  Explanation svc |
                                         |  (TS, Bayesian   |
                                         |   Engine)         |
                                         +-------------------+
                                                |
                                                v
                                         +-------------------+
                                         |  Model Store      |
                                         |  (PostgreSQL /    |
                                         |   Redis cache)    |
                                         +-------------------+
```

* **API Gateway** – Express server exposing `/explain` endpoint, validates payload, handles auth.  
* **Explanation Service** – Pure TypeScript module implementing the Bayesian updates; completely deterministic and testable.  
* **Model Store** – Persistent storage of priors/posteriors per feature; Redis cache for hot‑path reads, PostgreSQL for durability.  

All components are packaged as a Docker image (`Dockerfile` provided) and can be orchestrated with Kubernetes or Docker‑Compose.

---  

## Quickstart  

### Prerequisites  

* Node.js ≥ 18  
* Yarn or npm  
* Docker (optional, for containerised run)  

### Installation  

```bash
# Clone the repo
git clone https://github.com/yourorg/anomaly-explainability-api.git
cd anomaly-explainability-api

# Install dependencies
yarn install   # or npm ci

# Build TypeScript sources
yarn build
```

### Running locally  

```bash
# Start the API (defaults to port 3000)
yarn start
```

Or with Docker:

```bash
docker build -t anomaly-explainability .
docker run -p 3000:3000 anomaly-explainability
```

### Example: Requesting an explanation  

```typescript
import axios from 'axios';

async function getExplanation() {
  const payload = {
    timestamp: '2026-09-01T12:34:56Z',
    metric: 'cpu_utilization',
    value: 98.7,
    context: {
      host: 'web-01',
      region: 'us-east-1',
      load_average: 5.2,
      temperature: 72.3
    }
  };

  try {
    const response = await axios.post('http://localhost:3000/explain', payload);
    console.log('Explanation scores:');
    console.table(response.data.scores);
  } catch (err) {
    console.error('API error:', err.response?.data ?? err.message);
  }
}

getExplanation();
```

**Typical response**

```json
{
  "anomalyId": "c3f9e1b2-7a4d-4f1a-9d2e-5b6c8d9e0f12",
  "scores": [
    { "feature": "load_average", "bayesFactor": 12.4, "logScore": 2.