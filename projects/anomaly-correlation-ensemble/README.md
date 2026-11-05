# Anomaly Correlation Ensemble Engine  

**Category:** Data Science  
**Stack:** Python • FastAPI  

Unified API that brings together analytics, forecasting, and a knowledge base to detect, quantify, and explain anomalies across heterogeneous data streams.

---  

## Overview  

The **Anomaly Correlation Ensemble Engine (ACEE)** is a high‑performance service that:

* **Ingests** time‑series, event logs, and contextual metadata via a single FastAPI endpoint.  
* **Runs** a configurable ensemble of statistical, machine‑learning, and rule‑based detectors.  
* **Computes** correlation scores that link anomalies to root‑cause hypotheses stored in a built‑in knowledge base.  
* **Exposes** results through a clean RESTful API, enabling downstream dashboards, alerting pipelines, or automated remediation.  

Designed for data‑science teams that need a reproducible, production‑ready way to combine multiple anomaly‑detection techniques without writing boilerplate integration code.

---  

## Theory & Architecture  

```
+-------------------+        +----------------------+        +-------------------+
|   Data Ingestion  |  -->   |  Ensemble Engine     |  -->   |   Knowledge Base  |
| (FastAPI / HTTP)  |        |  - Stat. Detectors   |        |  (SQLite / PG)    |
+-------------------+        |  - ML Models         |        +-------------------+
                             |  - Rule Engine       |
                             +----------+-----------+
                                        |
                                        v
                               +-------------------+
                               |  Correlation Core |
                               |  (graph‑based     |
                               |   similarity)     |
                               +----------+--------+
                                          |
                                          v
                                 +-----------------+
                                 |  API Response   |
                                 |  (JSON / OpenAPI)|
                                 +-----------------+
```

### Core Components  

| Component | Responsibility | Key Technologies |
|-----------|----------------|------------------|
| **FastAPI Gateway** | HTTP request validation, authentication, and routing. | FastAPI, Pydantic, OAuth2 |
| **Ensemble Engine** | Executes a configurable list of detectors on the incoming data. | NumPy, pandas, scikit‑learn, Prophet, custom rule engine |
| **Correlation Core** | Constructs a bipartite graph linking detected anomalies to candidate causes, then computes a normalized correlation score (0‑1). | NetworkX, SciPy (sparse matrices) |
| **Knowledge Base** | Stores domain‑specific causal patterns, thresholds, and remediation actions. | SQLite (dev) / PostgreSQL (prod), SQLAlchemy |
| **Result Serializer** | Formats the output according to OpenAPI spec, optionally streaming large result sets. | FastAPI Response models, orjson |

### Detection Ensemble  

1. **Statistical** – Z‑score, Seasonal‑Decomposition of Time Series (STL), EWMA.  
2. **Machine‑Learning** – Isolation Forest, LSTM auto‑encoder, Prophet forecast residuals.  
3. **Rule‑Based** – User‑defined Boolean expressions on metadata fields.  

Each detector returns a *candidate anomaly* object `{timestamp, metric, score, detector_id}`. The ensemble aggregates these candidates, removes duplicates, and passes them to the correlation core.

### Correlation Scoring  

* Build a bipartite graph **G = (A ∪ C, E)** where **A** = anomalies, **C** = knowledge‑base causes.  
* Edge weight `w(a,c) = similarity(features(a), features(c))` (cosine similarity on engineered feature vectors).  
* Compute **normalized PageRank** on the bipartite projection to obtain a final correlation score `ρ ∈ [0,1]`.  

The approach yields both **what** (the anomaly) and **why** (most likely cause) in a single API call.

---  

## Quickstart  

### Prerequisites  

* Python 3.10+  
* `git`  
* (Optional) PostgreSQL instance for production deployment  

### Installation  

```bash
# Clone the repository
git clone https://github.com/yourorg/anomaly-correlation-ensemble-engine.git
cd anomaly-correlation-ensemble-engine

# Create a virtual environment
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Initialize the SQLite knowledge base (dev mode)
python -m acee.kb init --db sqlite:///knowledge.db
```

### Running the API (development)  

```bash
uvicorn acee.main:app --reload --host 0.0.0.0 --port 8000
```

Open your browser at <http://localhost:8000/docs> to explore the automatically generated OpenAPI UI.

### Example: Submitting a Time‑Series Payload  

```python
import requests
import pandas as pd
import json
from datetime import datetime, timedelta

# Generate synthetic data
now = datetime.utcnow()
timestamps