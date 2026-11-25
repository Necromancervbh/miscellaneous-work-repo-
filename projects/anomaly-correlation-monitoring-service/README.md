# Anomaly Correlation Monitoring Service  
**Category:** Data Science | **Stack:** Python • FastAPI • Pandas  

---  

## Overview  

The **Anomaly Correlation Monitoring Service (ACMS)** is a lightweight, high‑performance API that ingests streams of anomaly scores, applies Kalman filtering for noise reduction, and produces forward‑looking trend forecasts using Seasonal‑Trend decomposition via Loess (STL) combined with Bayesian inference.  

Key capabilities  

- **Score aggregation** – batch or real‑time ingestion of heterogeneous anomaly metrics.  
- **Kalman smoothing** – optimal linear‑Gaussian filtering to denoise noisy score series.  
- **STL decomposition** – separates seasonal, trend, and residual components for interpretability.  
- **Bayesian trend forecasting** – probabilistic predictions with credible intervals, enabling risk‑aware decision making.  
- **FastAPI endpoint** – RESTful interface for posting raw scores and retrieving smoothed/forecasted results.  

---  

## Theory & Architecture  

### 1. Data Flow  

```
[Client] ──► POST /scores ──► FastAPI ──► Pandas DataFrame
                                   │
                                   ▼
                     ┌─────────────────────────────┐
                     │  Kalman Filter (Linear Gaussian) │
                     └─────────────────────────────┘
                                   │
                                   ▼
                     ┌─────────────────────────────┐
                     │  STL Decomposition (statsmodels) │
                     └─────────────────────────────┘
                                   │
                                   ▼
                     ┌─────────────────────────────┐
                     │  Bayesian Trend Model (PyMC3) │
                     └─────────────────────────────┘
                                   │
                                   ▼
                     ──► JSON response (smoothed, trend, forecast)
```

### 2. Kalman Smoothing  

- **State equation:** `x_t = A·x_{t-1} + w_t`,  `w_t ∼ N(0, Q)`  
- **Observation equation:** `y_t = H·x_t + v_t`, `v_t ∼ N(0, R)`  
- Parameters `A, H, Q, R` are estimated from the first few hundred points via Expectation‑Maximization, then held fixed for online updates.  

### 3. STL Decomposition  

- Uses `statsmodels.tsa.seasonal.STL`.  
- Seasonal period (`period`) is configurable (default = 24 for hourly data).  
- Returns `trend`, `seasonal`, and `resid` components for downstream Bayesian modeling.  

### 4. Bayesian Trend Forecasting  

- **Model:** `trend_t ~ GaussianProcess(mean=μ, cov=K)` where the kernel `K` is a combination of a **RBF** (smooth long‑term drift) and **Periodic** (capturing recurring patterns).  
- Inference performed with **PyMC3** (or **PyMC** v4) using NUTS sampler.  
- Generates posterior predictive samples → median forecast + 95 % credible interval.  

### 5. Service Layer  

| Layer | Responsibility | Tech |
|-------|----------------|------|
| API   | Request validation, authentication (optional), routing | FastAPI, Pydantic |
| Core  | Data ingestion, preprocessing, model orchestration | Pandas, NumPy |
| Models| Kalman filter, STL, Bayesian inference | custom Python, statsmodels, PyMC3 |
| Persistence (optional) | Store raw scores & forecasts for audit | SQLite / PostgreSQL (via SQLModel) |

---  

## Quickstart  

### Prerequisites  

```bash
python >=3.9
pip install fastapi uvicorn pandas statsmodels pymc3
```

### 1. Clone & Install  

```bash
git clone https://github.com/yourorg/anomaly-correlation-monitoring-service.git
cd anomaly-correlation-monitoring-service
pip install -e .
```

### 2. Run the API  

```bash
uvicorn acms.main:app --reload --host 0.0.0.0 --port 8000
```

The service will be reachable at `http://localhost:8000`.

### 3. Post Scores & Retrieve Forecast  

```python
import requests
import pandas as pd
import numpy as np

# Simulated anomaly scores (timestamp, score)
rng = pd.date_range("2024-01-01", periods=120, freq="H")
scores = np.abs(np.random.randn(len(rng)))  # noisy scores
payload = {
    "timestamps": rng.astype(str).tolist(),
    "scores": scores.tolist()
}

# POST raw scores
resp = requests.post("http://localhost:8000/scores", json=payload)
resp.raise_for_status()
result = resp.json()

print("Smoothed scores (first 5):", result["smoothed"][:5])
print("Trend forecast (next 12h):", result["forecast"]["median"][:12])
print("95% CI:", result["forecast"]["ci_95"][:12])
```

#### Expected