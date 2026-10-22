# Anomaly Correlation Model Trainer
**Category:** Data Science  
**Stack:** TypeScript / Node.js / Python  

Automated training pipeline for Kalman filter and Bayesian models that detects, correlates, and quantifies anomalies in time‑series data.

---

## Overview
The **Anomaly Correlation Model Trainer** (ACMT) streamlines the end‑to‑end workflow for building and maintaining statistical models that capture complex temporal dynamics:

* **Kalman Filter** – optimal linear‑Gaussian state‑space estimation for real‑time tracking.  
* **Bayesian Models** – hierarchical and probabilistic frameworks (e.g., Bayesian Change‑Point, Gaussian Process) for robust uncertainty quantification.

Key capabilities:

| Feature | Description |
|---------|-------------|
| **Data ingestion** | Pulls raw series from CSV, Parquet, or streaming APIs. |
| **Pre‑processing** | Automatic missing‑value imputation, detrending, and scaling. |
| **Model selection** | Heuristic and cross‑validation based selection of Kalman vs. Bayesian pipelines. |
| **Training orchestration** | Node.js CLI drives Python workers via `child_process`. |
| **Artifact management** | Serializes trained parameters to a configurable model store (local FS or S3). |
| **Monitoring** | Emits training metrics (loss, log‑likelihood, convergence) to Prometheus. |

The project is deliberately language‑agnostic: the orchestration layer is written in TypeScript/Node.js, while the heavy‑lifting statistical routines live in Python (NumPy, SciPy, PyKalman, PyMC3).

---

## Theory / Architecture

### 1. System Architecture
```
┌─────────────────────┐
│   CLI (Node.js)     │   <-- user commands (train, evaluate, export)
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│   Orchestrator      │   (TypeScript)
│  - Job queue        │
│  - Config loader    │
│  - Process manager  │
└───────┬─────┬───────┘
        │     │
        ▼     ▼
┌─────────────┐   ┌─────────────┐
│ Python Env  │   │ Python Env  │
│ (Kalman)    │   │ (Bayesian)  │
│ - PyKalman  │   │ - PyMC3     │
│ - SciPy     │   │ - ArviZ     │
└───────┬─────┘   └───────┬─────┘
        │                 │
        ▼                 ▼
┌───────────────────────────────┐
│   Model Store (FS / S3)        │
│   - .pkl (Kalman)               │
│   - .trace (Bayesian)           │
└───────────────────────────────┘
```

### 2. Kalman Filter Pipeline
1. **State‑Space Definition**  
   \[
   \begin{aligned}
   \mathbf{x}_{t} &= \mathbf{A}\mathbf{x}_{t-1} + \mathbf{w}_{t}, \quad \mathbf{w}_{t}\sim\mathcal{N}(0,\mathbf{Q})\\
   \mathbf{y}_{t} &= \mathbf{H}\mathbf{x}_{t} + \mathbf{v}_{t}, \quad \mathbf{v}_{t}\sim\mathcal{N}(0,\mathbf{R})
   \end{aligned}
   \]
2. **Parameter Estimation** – Expectation‑Maximization (EM) maximizes the marginal likelihood of observations.  
3. **Anomaly Scoring** – Mahalanobis distance of residuals; thresholds derived from chi‑square quantiles.

### 3. Bayesian Pipeline
1. **Model Specification** – Hierarchical priors on drift, volatility, and change‑point locations.  
2. **Inference** – No‑U‑Turn Sampler (NUTS) via PyMC3, producing posterior samples.  
3. **Posterior Predictive Checks** – Compute predictive intervals; anomalies flagged when observed points fall outside the 95 % credible band.

### 4. Interaction Flow
* **CLI** parses `train --model kalman --config config.yaml`.  
* **Orchestrator** validates config, spawns a Python subprocess (`python train_kalman.py …`).  
* **Python worker** loads data, runs the selected algorithm, writes model artifacts, and streams JSON metrics back to the orchestrator.  
* **Orchestrator** aggregates metrics, updates Prometheus, and returns a concise summary to the user.

---

## Quickstart

### Prerequisites
```bash
# Node.js (>=18) and npm
# Python 3.10+ with virtualenv
# Optional: Docker for reproducible environment
```

### 1. Clone & Install
```bash
git clone https://github.com/yourorg