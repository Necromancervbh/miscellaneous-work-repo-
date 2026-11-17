# Anomaly Correlation Monitoring Service  
**Category:** Data Science  
**Stack:** Python • FastAPI  

Real‑time monitoring and drift detection for anomaly scores. The service ingests streaming anomaly scores, computes correlation‑based statistics, and raises alerts when the distribution drifts beyond configurable thresholds.

---  

## Overview  

The **Anomaly Correlation Monitoring Service (ACMS)** provides a lightweight, extensible API for:

* **Ingestion** – Push per‑event anomaly scores (or vectors) from any upstream detector.  
* **Correlation analysis** – Continuously compute Pearson/Spearman correlation matrices across score dimensions.  
* **Drift detection** – Compare the live correlation matrix with a baseline (e.g., using Frobenius norm, KL‑divergence, or matrix cosine similarity).  
* **Alerting** – Emit HTTP callbacks, Slack messages, or Prometheus metrics when drift exceeds user‑defined thresholds.  

Designed for low‑latency environments, ACMS can be deployed as a single Docker container or scaled horizontally behind a load balancer.

---  

## Theory / Architecture  

### 1. Data Flow  

```
[Detector] → (POST /scores) → ACMS → [Correlation Engine] → [Drift Detector] → Alerts
```

1. **Score Ingestion** – Clients POST JSON payloads containing a timestamp, an identifier, and a vector of anomaly scores.  
2. **Windowing** – Scores are buffered in a sliding time window (default 5 min, configurable).  
3. **Correlation Engine** – For each window, ACMS computes a correlation matrix **Cₜ** using the selected metric (Pearson, Spearman, or custom).  
4. **Baseline Comparison** – A reference matrix **C₀** (captured during a training period) is stored. Drift is measured as  

\[
\delta_t = \|C_t - C_0\|_F \quad\text{or}\quad
\delta_t = 1 - \frac{\langle C_t, C_0\rangle}{\|C_t\|_F \|C_0\|_F}
\]

5. **Alerting** – If \(\delta_t\) > threshold, an alert is generated via the configured channel(s).  

### 2. Core Components  

| Component | Responsibility | Key Technologies |
|-----------|----------------|------------------|
| **FastAPI Server** | HTTP endpoint, request validation, authentication | FastAPI, Pydantic |
| **Score Buffer** | In‑memory ring buffer for sliding windows | `collections.deque` |
| **Correlation Engine** | Vectorized matrix computation | NumPy, SciPy |
| **Drift Detector** | Baseline management, similarity metrics | NumPy, custom plugins |
| **Alert Dispatcher** | Sends alerts to external services | `httpx`, `slack_sdk`, Prometheus client |
| **Persistence Layer** (optional) | Store baseline, historic drift metrics | SQLite / PostgreSQL via SQLModel |

### 3. Extensibility  

* **Custom similarity functions** – Implement `SimilarityMetric` interface and register via `acms.plugins.register_metric`.  
* **Alternative storage** – Swap the default SQLite store with any SQLModel‑compatible backend.  
* **Authentication** – Plug in OAuth2, API keys, or mTLS by providing a FastAPI dependency.  

---  

## Quickstart  

### Prerequisites  

```bash
python >=3.9
docker (optional)
```

### Installation  

```bash
# Clone the repo
git clone https://github.com/yourorg/acms.git
cd acms

# Install dependencies in a virtual environment
python -m venv .venv
source .venv/bin/activate
pip install -e .
```

### Run the service  

```bash
# Development mode
uvicorn acms.main:app --reload --host 0.0.0.0 --port 8000

# Or with Docker
docker build -t acms:latest .
docker run -p 8000:8000 acms:latest
```

### Register a baseline (once)  

```bash
curl -X POST "http://localhost:8000/baseline" \
     -H "Content-Type: application/json" \
     -d '{
           "window_minutes": 10,
           "metric": "pearson",
           "samples": [
               {"timestamp": "2024-01-01T00:00:00Z", "scores": [0.12, 0.34, 0.56]},
               {"timestamp": "2024-01-01T00:00:10Z", "scores": [0.15, 0.30, 0.60]},
               ...
           ]
         }'
```

### Stream anomaly scores  

```python
import httpx
import time
import random
from datetime import datetime, timezone

API_URL = "http://localhost:8000/scores"

def generate_score():
    return {
        "timestamp": datetime.now(timezone.utc).iso