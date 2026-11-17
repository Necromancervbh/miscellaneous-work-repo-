# Anomaly Correlation Recommender
**Category:** Data Science  
**Stack:** Python • FastAPI • Neo4j  

A lightweight service that ingests anomaly events, builds a correlation graph in Neo4j, and returns context‑aware mitigation actions using Bayesian inference over the graph structure.

---  

## Overview
Operational systems generate thousands of alerts daily. Most of them are isolated noise, but some are symptoms of deeper, correlated failures. The **Anomaly Correlation Recommender** (ACR) bridges the gap between detection and remediation by:

* **Modeling** anomalies and their relationships as a property graph in Neo4j.  
* **Inferring** the most probable root cause and associated mitigation actions via Bayesian networks built on top of the graph.  
* **Exposing** a simple HTTP API (FastAPI) that returns ranked recommendations in real time.

Typical use‑cases:

| Domain | Example |
|--------|---------|
| Cloud infrastructure | “CPU spike on node A → network latency on node B → service timeout” |
| Manufacturing IoT | “Temperature outlier on sensor X → vibration anomaly on motor Y” |
| Finance | “Sudden price deviation on asset A → correlated trade volume surge on asset B” |

---  

## Theory & Architecture  

### 1. Graph Construction (Neo4j)
| Entity | Label | Key properties |
|--------|-------|----------------|
| Anomaly | `Anomaly` | `id`, `timestamp`, `metric`, `value`, `severity` |
| Mitigation | `Mitigation` | `id`, `description`, `cost`, `expected_reduction` |
| Correlation | `CORRELATED_WITH` | `weight` (0‑1), `lag_seconds` |
| Causes | `CAUSES` | `probability` (prior) |

* **Ingestion pipeline** (Python) parses raw alerts → creates/updates `Anomaly` nodes.  
* **Correlation engine** computes statistical similarity (e.g., Pearson, DTW) and creates `CORRELATED_WITH` edges with a confidence weight.  
* **Domain knowledge** (static CSV/JSON) adds `Mitigation` nodes and `CAUSES` edges linking anomalies to possible actions.

### 2. Bayesian Inference
1. **Prior** – each `Anomaly` node holds a prior probability of being the root cause (derived from historical failure rates).  
2. **Likelihood** – edge weight (`CORRELATED_WITH.weight`) acts as the likelihood of observing a downstream anomaly given an upstream one.  
3. **Posterior** – using Bayes’ rule, the service computes posterior probabilities for each candidate root cause and propagates them to attached `Mitigation` nodes via the `CAUSES` relationship.  

Mathematically:  

\[
P(R_i \mid \mathbf{A}) \propto P(R_i) \prod_{j} P(A_j \mid R_i)^{w_{ij}}
\]

where \(R_i\) is a candidate root cause, \(A_j\) are observed anomalies, and \(w_{ij}\) is the edge weight.

### 3. Service Layer (FastAPI)
* **`/recommend`** – POST endpoint that receives a list of recent anomaly IDs and returns a ranked list of mitigation actions.  
* **`/graph`** – GET endpoint for visualising the sub‑graph (useful for debugging).  
* **Background workers** (via `asyncio` or Celery) keep the Neo4j graph up‑to‑date.

### 4. Deployment Diagram  

```
+----------------+      +----------------+      +-------------------+
|   Data Source  | ---> |   Ingestion    | ---> |   Neo4j Graph DB |
| (metrics, logs)|      |   (Python)     |      +-------------------+
+----------------+      +----------------+                |
                                                        |
                                                +-----------------+
                                                |  FastAPI Server |
                                                +-----------------+
                                                        |
                                                +-----------------+
                                                |   Clients (UI, |
                                                |   other services)|
                                                +-----------------+
```

---  

## Quickstart  

### Prerequisites
```bash
python >=3.9
docker-compose
```

### 1. Clone & start the stack
```bash
git clone https://github.com/yourorg/anomaly-correlation-recommender.git
cd anomaly-correlation-recommender
docker-compose up -d   # brings up Neo4j and the FastAPI container
```

### 2. Install the Python client library
```bash
pip install -e .
# or, if you prefer a virtual environment
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 3. Populate a few demo anomalies
```python
from acr.ingest import ingest_anomaly
from datetime import datetime

samples = [
    {"id": "a1", "timestamp": datetime.utcnow(), "metric": "cpu", "value": 92, "severity": "high"},
    {"id": "a2", "timestamp": datetime.utcnow(), "metric": "latency", "value": 350