# Anomaly Correlation Alert Service  
**Category:** Data Science  
**Stack:** Node.js / TypeScript  

Real‑time alerting with Bayesian scoring and WebSocket notifications.

---  

## Overview  

The **Anomaly Correlation Alert Service** (ACAS) ingests streaming metrics, evaluates each observation against a Bayesian anomaly model, and pushes alerts to subscribed clients over WebSocket. It is designed for low‑latency environments where rapid detection of correlated anomalies across multiple dimensions is critical (e.g., IoT sensor networks, financial tick data, or production monitoring).

Key features  

- **Bayesian scoring** – probabilistic confidence for each anomaly.  
- **Correlation engine** – groups related anomalies across dimensions.  
- **WebSocket notifications** – push‑based delivery to dashboards or automated responders.  
- **Type‑safe API** – full TypeScript typings for model definitions and client contracts.  
- **Extensible plug‑in architecture** – swap data sources, scoring functions, or transport layers.

---  

## Theory / Architecture  

### 1. Data Flow  

```
[Data Source] → (Kafka / RabbitMQ) → [Ingestion Service] → [Scoring Engine] → [Correlation Engine] → [Alert Dispatcher] → [WebSocket Server] → Clients
```

1. **Ingestion Service** normalises incoming JSON payloads into a canonical `Metric` interface.  
2. **Scoring Engine** computes a Bayesian posterior `P(anomaly | data)` using a conjugate prior (Beta/Bernoulli for binary events, Normal‑Inverse‑Gamma for continuous).  
3. **Correlation Engine** maintains a sliding‑window graph where nodes are scored events and edges represent temporal or semantic similarity (e.g., cosine similarity of feature vectors). Communities are extracted with the Louvain method to produce correlated alert groups.  
4. **Alert Dispatcher** thresholds the posterior probability (`p > τ`) and the correlation strength (`ρ > κ`) before emitting an `Alert` object.  
5. **WebSocket Server** broadcasts alerts to all subscribed sessions, optionally filtering by client‑provided subscription criteria.

### 2. Core Types  

```ts
interface Metric {
  id: string;
  timestamp: number;          // epoch ms
  tags: Record<string, string>;
  values: Record<string, number>;
}

interface Score {
  metricId: string;
  posterior: number;          // Bayesian probability of anomaly
  variance: number;
}

interface Alert {
  alertId: string;
  score: Score;
  correlatedIds: string[];
  severity: 'low' | 'medium' | 'high';
  createdAt: number;
}
```

### 3. Bayesian Scoring  

For a continuous metric `x`, we assume a Normal likelihood with unknown mean μ and variance σ².  
- Prior: Normal‑Inverse‑Gamma `(μ₀, λ, α, β)`  
- Posterior update after each observation `xₙ` is analytic, yielding a closed‑form posterior predictive distribution.  
- Anomaly score = `1 - CDF(prediction, xₙ)` (two‑tailed).

For binary events we use a Beta‑Bernoulli model:  

```
posterior = (α + successes) / (α + β + trials)
```

The service exposes a `ScoreEngine` class that abstracts these updates.

### 4. Correlation Graph  

- **Nodes**: latest `Score` objects (window size *W*).  
- **Edge weight** `w(i,j) = sim(features_i, features_j) * exp(-|t_i - t_j|/τ)`.  
- **Community detection** runs every *Δt* seconds; each community becomes a single `Alert` with aggregated severity.

---  

## Quickstart  

### Prerequisites  

- Node.js ≥ 18  
- Yarn or npm  
- (Optional) Docker & Docker Compose for Kafka & Redis (used in the default dev stack)

### 1. Clone & Install  

```bash
git clone https://github.com/yourorg/anomaly-correlation-alert-service.git
cd anomaly-correlation-alert-service
yarn install   # or npm ci
```

### 2. Run the supporting services (Kafka + Redis)  

```bash
docker compose up -d
```

### 3. Build & start the service  

```bash
yarn build
yarn start
```

The service listens on:

- **HTTP API** – `http://localhost:3000/api/v1` (health, metrics, manual scoring)  
- **WebSocket** – `ws://localhost:3000/ws/alerts`

### 4. Send a sample metric and receive an alert  

```ts
import WebSocket from 'ws';
import axios from 'axios';

const ws = new WebSocket('ws://localhost:3000/ws/alerts');

ws.on('message', (data) => {
  console.log('🚨 Alert received:', JSON.parse(data.toString()));
});

async function pushMetric() {
  await axios.post('http://localhost:3000/api/v1/metrics', {
    id: 'sensor-42',
    timestamp: Date.now(),
    tags: { location: 'warehouse-1' },
    values: { temperature: 78.3, humidity: 55.2 }
  });
}

pushMetric().catch(console.error);
``