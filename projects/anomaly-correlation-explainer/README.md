# Anomaly Correlation Explainer
**Category:** Data Science  
**Stack:** Python • FastAPI  

Explain anomalies with Bayesian inference and causal scores.

---

## Overview
The **Anomaly Correlation Explainer** is a lightweight service that ingests time‑series or event data, detects anomalous points, and provides a probabilistic explanation of *why* each anomaly occurred. It combines:

* **Bayesian inference** – to compute posterior probabilities of latent causes given observed anomalies.  
* **Causal scoring** – to rank contributing features/variables by their impact on the anomaly.  

The core logic lives in pure Python, while a FastAPI wrapper exposes a clean REST API for integration with dashboards, monitoring pipelines, or automated alerting systems.

---

## Theory / Architecture

### 1. Bayesian Anomaly Model
1. **Generative model**  
   - Let **X** be the observed feature vector at time *t*.  
   - Assume a latent cause vector **Z** (e.g., sensor drift, external shock).  
   - The joint distribution is modeled as  
     \[
     p(X, Z) = p(Z) \, p(X \mid Z)
     \]
   - Prior \(p(Z)\) is defined by domain‑specific distributions (Gaussian, Beta, etc.).  
   - Likelihood \(p(X \mid Z)\) is a multivariate Gaussian with mean \(\mu(Z)\) and covariance \(\Sigma\).

2. **Posterior inference**  
   - For a new observation \(X_t\) flagged as anomalous by a pre‑filter (e.g., z‑score, isolation forest), we compute the posterior  
     \[
     p(Z \mid X_t) \propto p(X_t \mid Z) \, p(Z)
     \]
   - Approximation is performed via **Variational Bayes** or **Monte‑Carlo sampling** (configurable).

### 2. Causal Scoring
* After obtaining posterior samples \(\{Z^{(s)}\}\), we evaluate the **expected causal effect** of each observed feature \(X_i\) on the anomaly score:
  \[
  \text{Score}_i = \mathbb{E}_{Z}\!\big[ \lvert \partial \log p(X \mid Z) / \partial X_i \rvert \big]
  \]
* Scores are normalized to \([0, 1]\) and returned as a ranked list.

### 3. System Architecture
```
┌─────────────────────┐
│   FastAPI Server    │
│ (uvicorn + gunicorn)│
└───────▲───────▲─────┘
        │       │
   HTTP│   WebSocket│
        │       │
┌───────▼───────▼─────┐
│   Anomaly Engine   │
│  (bayesian.py,     │
│   causal.py)       │
└───────▲───────▲─────┘
        │       │
   Data │   Model│
   Store│   Cache│
        │       │
┌───────▼───────▼─────┐
│   Persistence Layer│
│ (PostgreSQL / Redis)│
└─────────────────────┘
```
* **API Layer** – validates requests, handles authentication, streams results.  
* **Engine** – pure‑Python core that performs inference and scoring.  
* **Persistence** – optional storage for model parameters, historic explanations, and caching of posterior samples.

---

## Quickstart

### Prerequisites
```bash
python >=3.9
pip install -r requirements.txt
```
Typical `requirements.txt` includes:
```
fastapi
uvicorn[standard]
numpy
scipy
pymc3   # or pyro for Bayesian inference
pandas
```

### Running the Service
```bash
# Start the API (development mode)
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### Example: Explain an Anomaly
```python
import requests
import pandas as pd

# 1️⃣ Prepare a payload – a single observation that triggered an alert
payload = {
    "timestamp": "2026-11-15T14:32:00Z",
    "features": {
        "temperature": 87.3,
        "pressure": 102.5,
        "vibration": 0.42,
        "flow_rate": 15.8
    }
}

# 2️⃣ Call the explanation endpoint
resp = requests.post(
    "http://localhost:8000/explain",
    json=payload,
    timeout=10
)

# 3️⃣ Inspect the result
explanation = resp.json()
print("Posterior mean of latent causes:")
print(pd.DataFrame(explanation["posterior_means"]))
print("\nCausal scores (higher → more responsible):")
print(pd.Series(explanation["causal_scores"]).sort_values(ascending=False