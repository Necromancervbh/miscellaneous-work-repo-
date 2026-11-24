# Anomaly Correlation Ensemble API  
**Category:** Data Science | **Stack:** Python • FastAPI  

Ensemble inference combining a Kalman filter and DBSCAN for robust, real‑time anomaly detection.

---  

## Overview  

The **Anomaly Correlation Ensemble API** exposes a lightweight HTTP service that fuses two complementary anomaly detection techniques:

| Component | Role |
|-----------|------|
| **Kalman Filter** | Provides a predictive, state‑space model that captures temporal dynamics and smooths noisy measurements. |
| **DBSCAN** | Performs density‑based clustering on residuals (observed – predicted) to flag outliers that deviate from the learned dynamics. |
| **Ensemble Logic** | Correlates the Kalman filter’s prediction error with DBSCAN’s cluster labels, yielding a confidence‑scored anomaly flag. |

The API is designed for streaming or batch data pipelines where low latency and high detection robustness are required (e.g., IoT sensor streams, financial tick data, industrial process monitoring).

---  

## Theory & Architecture  

### 1. Kalman Filter (Temporal Modeling)  

- **State Equation**: \(\mathbf{x}_{t} = \mathbf{F}\mathbf{x}_{t-1} + \mathbf{w}_{t}\)  
- **Observation Equation**: \(\mathbf{z}_{t} = \mathbf{H}\mathbf{x}_{t} + \mathbf{v}_{t}\)  

where \(\mathbf{w}_{t}\sim\mathcal{N}(0,\mathbf{Q})\) and \(\mathbf{v}_{t}\sim\mathcal{N}(0,\mathbf{R})\).  
The filter recursively produces a **prediction** \(\hat{\mathbf{z}}_{t}\) and a **residual** \(\mathbf{r}_{t}= \mathbf{z}_{t} - \hat{\mathbf{z}}_{t}\). Large residuals may indicate anomalies, but noise‑induced spikes can cause false positives.

### 2. DBSCAN (Residual Clustering)  

- Operates on a sliding window of residual vectors \(\{\mathbf{r}_{t-w},\dots,\mathbf{r}_{t}\}\).  
- Parameters: `eps` (neighbourhood radius) and `min_samples`.  
- Points labeled **-1** are considered noise/outliers.  

DBSCAN is insensitive to the shape of the residual distribution and can isolate isolated spikes that the Kalman filter alone would miss.

### 3. Ensemble Correlation  

1. **Score Kalman**: Compute normalized residual magnitude \(s^{K}_{t}= \|\mathbf{r}_{t}\| / \sigma_{r}\).  
2. **Score DBSCAN**: Assign binary label \(s^{D}_{t}\in\{0,1\}\) (1 = outlier).  
3. **Fusion**:  
   \[
   \text{AnomalyScore}_{t}= \alpha \cdot \text{sigmoid}(s^{K}_{t}) + (1-\alpha)\cdot s^{D}_{t}
   \]  
   where \(\alpha\in[0,1]\) balances temporal vs. density evidence.  
4. **Threshold**: If `AnomalyScore_t > τ` → return `anomaly=True` with confidence `AnomalyScore_t`.

### 4. Service Architecture  

```
+-------------------+        +-------------------+        +-------------------+
|   FastAPI Server  | <----> |   AnomalyEngine   | <----> |   Data Source(s)  |
|   /detect endpoint|        |  - Kalman Filter  |        | (JSON, CSV, etc.) |
|                   |        |  - DBSCAN Cluster |        +-------------------+
+-------------------+        |  - Ensemble Logic |
                             +-------------------+
```

* The **AnomalyEngine** is a singleton instantiated at startup, keeping the Kalman state and a rolling buffer for DBSCAN.  
* Requests contain a JSON payload with a timestamp and measurement vector.  
* Responses return `{ "anomaly": bool, "score": float, "details": {...} }`.

---  

## Quickstart  

### 1. Install  

```bash
# Clone the repo
git clone https://github.com/yourorg/anomaly-correlation-ensemble.git
cd anomaly-correlation-ensemble

# Create a virtual environment
python -m venv .venv
source .venv/bin/activate   # on Windows: .venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt
```

### 2. Run the API  

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

The service will be reachable at `http://localhost:8000`.

### 3. Call the `/detect` endpoint  

```python
import requests
import numpy as np

# Example measurement (e.g., 3‑dimensional sensor reading)
measurement = np.array([12.4,