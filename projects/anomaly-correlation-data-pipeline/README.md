# Anomaly Correlation Data Pipeline  
*Category: Data Science*  
*Stack: Python • FastAPI • Pandas*  

---  

## Overview  

The **Anomaly Correlation Data Pipeline** is an end‑to‑end ETL service that ingests raw time‑series streams, applies **Kalman smoothing** to denoise the data, and enriches each record with **TF‑IDF** features derived from categorical annotations. The processed payload is then exposed through a **FastAPI** endpoint for downstream analytics, alerting, or model training.  

Key benefits  

- **Real‑time smoothing** – Kalman filter reduces measurement noise while preserving underlying trends.  
- **Contextual enrichment** – TF‑IDF captures the importance of categorical tokens (e.g., log messages, tags) relative to the whole stream.  
- **Scalable API** – FastAPI provides asynchronous handling and automatic OpenAPI documentation.  
- **Modular design** – Each stage (extract, transform, load) is isolated, making testing and extension straightforward.  

---  

## Theory & Architecture  

### 1. Data Flow  

```
[Source Stream] ──► Extractor (Pandas) ──► Kalman Smoother ──► TF‑IDF Vectorizer ──► Loader (FastAPI) ──► [Consumer]
```

1. **Extractor** – Reads CSV, JSON, or Kafka payloads into a `pandas.DataFrame`.  
2. **Kalman Smoother** – Implements a linear‑Gaussian state‑space model:  

   \[
   \begin{aligned}
   x_{t} &= A x_{t-1} + w_{t}, \quad w_{t}\sim\mathcal{N}(0,Q)\\
   y_{t} &= H x_{t} + v_{t}, \quad v_{t}\sim\mathcal{N}(0,R)
   \end{aligned}
   \]

   where `A` (transition) and `H` (observation) are identity matrices for scalar series.  
3. **TF‑IDF Vectorizer** – Uses `sklearn.feature_extraction.text.TfidfTransformer` on tokenised categorical columns.  
4. **Loader** – Packages the enriched DataFrame into JSON and serves it via a FastAPI route (`/process`).  

### 2. Core Modules  

| Module | Responsibility | Key Classes / Functions |
|--------|----------------|--------------------------|
| `extractor.py` | Load raw data into `DataFrame` | `load_csv()`, `load_json()`, `load_kafka()` |
| `kalman.py` | Apply smoothing | `KalmanFilter`, `smooth_series()` |
| `tfidf.py` | Compute TF‑IDF vectors | `fit_transform()`, `transform()` |
| `api.py` | FastAPI service definition | `app`, `process_endpoint()` |
| `pipeline.py` | Orchestrates the steps | `run_pipeline()` |

### 3. Design Principles  

- **Stateless endpoints** – All transformations are pure functions; the API does not retain mutable state between requests.  
- **Lazy evaluation** – TF‑IDF vocabulary is built on the first request and cached; subsequent calls reuse it.  
- **Type safety** – Pydantic models validate incoming payloads and outgoing responses.  
- **Observability** – Integrated logging (structlog) and Prometheus metrics for request latency and error rates.  

---  

## Quickstart  

### Prerequisites  

```bash
python >=3.9
pip install -r requirements.txt
```

`requirements.txt` (excerpt)

```
fastapi
uvicorn[standard]
pandas
scikit-learn
numpy
structlog
prometheus-client
```

### Running the service locally  

```bash
uvicorn api:app --reload --host 0.0.0.0 --port 8000
```

The OpenAPI docs are available at `http://localhost:8000/docs`.

### Example: Sending a stream for processing  

```python
import requests
import pandas as pd
import json

# Simulated raw data
data = pd.DataFrame({
    "timestamp": pd.date_range("2023-01-01", periods=5, freq="T"),
    "value": [10.2, 9.8, 11.5, 10.9, 12.1],
    "tags": ["error", "warning", "error", "info", "error"]
})

# Convert to JSON payload expected by the API
payload = {
    "records": data.to_dict(orient="records")
}

response = requests.post(
    "http://localhost:8000/process",
    json=payload,
    headers={"Content-Type": "application/json"}
)

print("Status:", response.status_code)
print("Enriched payload:", json.dumps(response.json(), indent=2))
```

**What happens under the hood**

1. The API receives the JSON, validates it with a Pyd