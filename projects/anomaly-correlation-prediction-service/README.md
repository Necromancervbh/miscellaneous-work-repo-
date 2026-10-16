# Anomaly Correlation Prediction Service

**Category:** Data Science  
**Stack:** TypeScript / Python  

Predict future anomaly scores by fusing a Kalman filter with Bayesian updating. The service continuously refines its forecasts as new observations arrive, delivering robust, real‑time anomaly correlation estimates for monitoring pipelines, IoT fleets, financial streams, and more.

---  

## Overview  

The **Anomaly Correlation Prediction Service** (ACPS) provides a simple API to:

* Ingest raw anomaly scores (e.g., from an outlier detector).  
* Apply a linear‑Gaussian Kalman filter to smooth noisy observations.  
* Perform Bayesian updating to incorporate prior knowledge and quantify uncertainty.  
* Emit forward‑looking predictions with confidence intervals.

The service is deliberately language‑agnostic: core algorithms live in a **Python** library (`acps-py`), while a **TypeScript** wrapper (`acps-ts`) offers seamless integration into Node.js / browser environments.

---  

## Theory / Architecture  

### 1. Kalman Filter  

The Kalman filter models the hidden anomaly state `x_t` as a first‑order Markov process:

```
x_t   = A * x_{t-1} + w_t        (process model)
z_t   = H * x_t + v_t            (observation model)
w_t ~ N(0, Q)                    (process noise)
v_t ~ N(0, R)                    (measurement noise)
```

* **A** – state transition matrix (usually 1 for a scalar anomaly score).  
* **H** – observation matrix (also 1).  
* **Q** – process‑noise covariance (captures expected drift).  
* **R** – measurement‑noise covariance (captures sensor/algorithm noise).

The filter recursively computes the posterior mean `μ_t` and covariance `Σ_t` given all observations up to `t`.

### 2. Bayesian Updating  

After each Kalman step we optionally incorporate a **prior distribution** `π(x_t)` (e.g., a domain‑specific belief about anomaly magnitude). Using Bayes’ rule:

```
p(x_t | z_{1:t}) ∝ p(z_t | x_t) * p(x_t | z_{1:t-1}) * π(x_t)
```

In practice we treat `π` as an additional Gaussian term, which simply adds to the posterior mean and reduces variance.

### 3. Service Architecture  

```
+-------------------+        +-------------------+
|   Client (TS)     |  RPC   |   Python Engine   |
|  (acps-ts)        | <----> | (acps-py)         |
+-------------------+        +-------------------+
        |                               |
        | 1. POST /predict               |
        |   {scores: [...]}              |
        v                               v
   FastAPI / Flask                Kalman + Bayes
        |                               |
        | 2. JSON {mean, var, ci}       |
        +-------------------------------+
```

* **TypeScript wrapper** (`acps-ts`) handles request construction, input validation, and result parsing.  
* **Python engine** (`acps-py`) implements the numerical core using `numpy` and `scipy`.  
* Communication is via a lightweight HTTP JSON API (FastAPI) or can be swapped for gRPC in production.

---  

## Quickstart  

### Prerequisites  

```bash
# Python
python -m venv .venv && source .venv/bin/activate
pip install acps-py fastapi uvicorn

# TypeScript
npm i acps-ts axios
```

### 1. Start the Python service  

```bash
uvicorn acps_py.server:app --host 0.0.0.0 --port 8000
```

The API is now listening at `http://localhost:8000/predict`.

### 2. Call from TypeScript  

```typescript
import { AnomalyPredictor } from "acps-ts";

async function runDemo() {
  const predictor = new AnomalyPredictor("http://localhost:8000");

  // Example raw anomaly scores from a sensor
  const scores = [0.12, 0.15, 0.30, 0.28, 0.45];

  const result = await predictor.predict(scores, {
    // optional hyper‑parameters
    processNoise: 1e-4,
    measurementNoise: 1e-2,
    priorMean: 0.0,
    priorVar: 0.1,
  });

  console.log("Predicted mean :", result.mean);
  console.log("Predicted variance :", result.variance);
  console.log("95% CI :", result.confidenceInterval);
}

runDemo().catch(console.error);
```

### 3. Call directly from Python (no HTTP)  

```python
from acps_py.kalman import AnomalyKalmanFilter

# Initialise filter with hyper‑parameters
kf = AnomalyKalmanFilter(
    process_noise=1e-4,
    measurement_noise