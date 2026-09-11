# Anomaly Correlation Forecast Service
*Category:* Data Science  
*Stack:* Node.js / TypeScript / Python  

---  

## Overview  

The **Anomaly Correlation Forecast Service** is a lightweight, language‑agnostic API that turns raw anomaly scores into actionable forecasts and confidence intervals.  
- **Input:** Time‑ordered anomaly scores (e.g., from monitoring pipelines).  
- **Output:** Predicted future scores, upper/lower confidence bounds, and a correlation‑based anomaly likelihood metric.  

Designed for real‑time dashboards, alerting systems, and batch analytics, the service abstracts the statistical heavy‑lifting while exposing a clean, type‑safe client library for Node.js/TypeScript and a Python wrapper for data‑science workflows.

---  

## Theory / Architecture  

### 1. Core Forecast Engine (Python)  
- **Model:** Seasonal ARIMA with a Gaussian Process (GP) residual layer to capture non‑linear patterns.  
- **Correlation Metric:** Pearson‑based sliding‑window correlation between the observed score series and its forecasted counterpart, transformed into a bounded anomaly likelihood \([0,1]\).  
- **Confidence Intervals:** Derived from the GP posterior variance, yielding a 95 % prediction band.  

### 2. Service Layer (Node.js)  
- **Express + TypeScript** server exposing a RESTful JSON API (`/forecast`).  
- **Endpoints:**  
  - `POST /forecast` – Accepts an array of `{ timestamp: string, score: number }`.  
  - `GET /health` – Liveness probe.  
- **Interop:** The Node server spawns a Python subprocess (`python3 forecast_engine.py`) and communicates via stdin/stdout using a compact JSON protocol.  

### 3. Deployment Diagram  

```
+-------------------+        HTTP/JSON        +-------------------+
|   Client (TS/JS)  | <---------------------> |  Node.js Service  |
+-------------------+                         +-------------------+
                                                    |
                                                    | spawn
                                                    v
                                           +-------------------+
                                           |   Python Engine   |
                                           | (statsmodels + GP)|
                                           +-------------------+
```

- **Scalability:** Stateless; horizontal scaling achieved by load‑balancing multiple Node instances behind a reverse proxy (e.g., Nginx).  
- **Observability:** Logs emitted in structured JSON; metrics exported via Prometheus client (`process_cpu_seconds_total`, `forecast_latency_seconds`).  

---  

## Quickstart  

### Prerequisites  

```bash
# System
python3 >=3.9
node >=18
npm >=9

# Python deps
pip install -r python/requirements.txt

# Node deps
npm install
```

### 1. Start the service  

```bash
# From the project root
npm run dev   # runs ts-node-dev, watches for changes
```

The API will be available at `http://localhost:3000`.

### 2. Call the API from TypeScript  

```typescript
import axios from 'axios';

interface ScorePoint {
  timestamp: string; // ISO 8601
  score: number;
}

async function getForecast(data: ScorePoint[]) {
  const resp = await axios.post('http://localhost:3000/forecast', { series: data });
  return resp.data; // { forecast: [...], lower: [...], upper: [...], correlation: number }
}

// Example usage
const series: ScorePoint[] = [
  { timestamp: '2024-09-01T00:00:00Z', score: 0.12 },
  { timestamp: '2024-09-01T01:00:00Z', score: 0.15 },
  // … more points …
];

getForecast(series).then(console.log).catch(console.error);
```

### 3. Call the API from Python  

```python
import requests
import datetime

series = [
    {"timestamp": "2024-09-01T00:00:00Z", "score": 0.12},
    {"timestamp": "2024-09-01T01:00:00Z", "score": 0.15},
    # … more points …
]

resp = requests.post("http://localhost:3000/forecast", json={"series": series})
forecast = resp.json()
print(forecast)
```

### 4. Run the built‑in test suite  

```bash
npm test          # Jest unit tests for the Node layer
pytest python/    # Pytest for the Python engine
```

---  

## Complexity Analysis  

| Component                | Time Complexity                              | Space Complexity                         |
|--------------------------|----------------------------------------------|------------------------------------------|
| **ARIMA fitting**        | `O(p·n)` where `p` = AR order, `n` = series length | `O(p)` for coefficient storage |
| **Gaussian Process**