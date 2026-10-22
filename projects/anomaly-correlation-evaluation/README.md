# Anomaly Correlation Evaluation Service

**Category:** Data Science  
**Stack:** Node.js • TypeScript • Python  

**Description:**  
A lightweight service that evaluates trained anomaly‑detection models, computes correlation‑based performance metrics, and exposes the results via a RESTful API. It bridges the gap between model training pipelines (often in Python) and production monitoring dashboards built on Node.js/TypeScript.

---  

## Overview  

The Anomaly Correlation Evaluation Service (ACES) automates the validation of time‑series anomaly detectors. It:

* **Ingests** model predictions and ground‑truth labels (CSV, JSON, or streaming sources).  
* **Computes** a suite of correlation‑centric metrics (Pearson, Spearman, Kendall, and custom anomaly‑specific scores).  
* **Serves** the metrics through a JSON API for downstream alerting, reporting, or CI/CD gating.  
* **Supports** both batch evaluation (Python scripts) and real‑time evaluation (Node.js microservice).  

By decoupling metric computation from model training, ACES enables data‑science teams to iterate faster while giving engineers a stable, versioned endpoint for model performance monitoring.

---  

## Theory / Architecture  

### 1. Data Flow  

```
+----------------+      +-------------------+      +-------------------+
|  Model Output  | ---> |  Python Evaluator | ---> |  Metrics Store    |
| (CSV/JSON)     |      | (ts-node bridge)  |      | (PostgreSQL/Redis)|
+----------------+      +-------------------+      +-------------------+
                                                          |
                                                          v
                                                +-------------------+
                                                |  Node.js API      |
                                                |  (Express/TS)     |
                                                +-------------------+
```

* **Python Evaluator** – a thin wrapper around `numpy`, `pandas`, and `scipy` that loads predictions/labels, aligns timestamps, and calculates correlation metrics.  
* **Metrics Store** – persists the latest evaluation results; can be swapped between a relational DB (PostgreSQL) for auditability or an in‑memory cache (Redis) for low‑latency reads.  
* **Node.js API** – a TypeScript‑based Express server exposing endpoints such as `GET /metrics/:modelId` and `POST /evaluate`. It also handles authentication, request validation, and rate limiting.

### 2. Core Metric Formulas  

| Metric | Formula (for vectors *x* and *y*) | Interpretation |
|--------|-----------------------------------|----------------|
| **Pearson r** | ![r = \frac{\sum (x_i-\bar{x})(y_i-\bar{y})}{\sqrt{\sum (x_i-\bar{x})^2 \sum (y_i-\bar{y})^2}}](https://latex.codecogs.com/svg.image?r%20=%20\frac{\sum%20(x_i-\bar{x})(y_i-\bar{y})}{\sqrt{\sum%20(x_i-\bar{x})^2%20\sum%20(y_i-\bar{y})^2}}) | Linear relationship strength |
| **Spearman ρ** | Pearson correlation of rank‑transformed *x* and *y* | Monotonic relationship |
| **Kendall τ** | ![τ = \frac{(C-D)}{n(n-1)/2}](https://latex.codecogs.com/svg.image?\tau%20=%20\frac{(C-D)}{n(n-1)/2}) where *C* = concordant pairs, *D* = discordant pairs | Ordinal association |
| **Anomaly‑Precision Correlation (APC)** | Weighted Pearson where anomalies (label = 1) receive higher weight *w* | Emphasizes correct anomaly detection |

### 3. Service Contracts  

* **POST `/evaluate`**  
  *Body:* `{ modelId: string, predictions: string (URL or base64), labels: string, weights?: number }`  
  *Response:* `{ modelId, metrics: { pearson, spearman, kendall, apc }, evaluatedAt }`

* **GET `/metrics/:modelId`**  
  *Response:* `{ modelId, latestMetrics, history: [{ timestamp, metrics }] }`

### 4. Extensibility  

* Add new metrics by implementing a Python function that returns a `float` and exposing it via the bridge.  
* Swap the Python evaluator for a Rust‑based binary for ultra‑high‑throughput scenarios – the Node.js side only cares about the JSON payload.

---  

## Quickstart  

### Prerequisites  

* Node.js ≥ 18  
* Python ≥ 3.9 with `pip`  
* Docker (optional, for containerised run)  

### 1. Clone & Install  

```bash
git clone https://github.com/yourorg/aces.git
cd aces

# Install Node.js dependencies
npm ci

# Install Python dependencies in a virtual environment
python -m venv .venv
source .venv/bin/activate
pip install -r python/requirements.txt
```

### 2. Run locally (development mode)  

```bash
# Start the Python evaluator as a background service
python python/evaluator.py &

# Start