# Anomaly Correlation Explainability Service  

**Category:** Data Science  
**Stack:** Node.js • TypeScript • Python  

---  

## Overview  

The **Anomaly Correlation Explainability Service** (ACES) turns opaque anomaly‑correlation predictions into human‑readable insights. It ingests raw sensor/metric streams, runs a machine‑learning model to detect correlated anomalies, and then produces interpretable explanations (feature importance, counterfactuals, visual overlays) that data scientists and domain experts can act on.  

Key benefits  

| ✅ | Feature |
|---|---|
| **Model‑agnostic** | Works with any anomaly‑correlation model that outputs a probability score. |
| **Hybrid stack** | Core service in Node.js/TypeScript for API orchestration; heavy‑weight explainability logic in Python (SHAP, LIME, causal inference). |
| **Realtime & batch** | Supports streaming inference via WebSocket and bulk analysis via REST. |
| **Extensible** | Plug‑in architecture for custom explainers, visualizers, and data adapters. |

---  

## Theory / Architecture  

### 1. Data Flow  

```
[Source] → (Ingestion Adapter) → [Feature Store] → (Model Service) → [Anomaly Scores]
                                                            ↓
                                                   (Explainability Engine)
                                                            ↓
                                                   [Explainability API]
```

1. **Ingestion Adapter** – Node.js connectors (Kafka, MQTT, HTTP) normalize incoming time‑series into a unified JSON schema.  
2. **Feature Store** – PostgreSQL + TimescaleDB holds engineered features used by the anomaly model.  
3. **Model Service** – A separate Python micro‑service (e.g., FastAPI) serves the correlation model (e.g., Graph Neural Network, Bayesian Network).  
4. **Explainability Engine** – Python library that receives a prediction, runs model‑agnostic explainers (SHAP, LIME) and causal analysis, then serializes the result.  
5. **Explainability API** – Node.js/Express gateway exposes `/explain` endpoints, handling auth, rate‑limiting, and response formatting.  

### 2. Core Components  

| Component | Language | Responsibility |
|-----------|----------|----------------|
| **Gateway** | TypeScript (Node.js) | HTTP/WebSocket routing, request validation, auth, orchestration. |
| **Model Runner** | Python | Loads the anomaly‑correlation model, returns probability scores. |
| **Explainer** | Python | Executes SHAP/LIME, generates counterfactuals, computes feature attribution matrices. |
| **Persistence Layer** | TypeScript (TypeORM) | Stores raw inputs, predictions, and generated explanations for audit. |
| **Visualization SDK** | TypeScript (React) | Optional UI library for rendering heatmaps, dependency graphs, and narrative text. |

### 3. Explainability Pipeline  

1. **Input receipt** – JSON payload with `entityId`, `timestamp`, and optional raw features.  
2. **Feature enrichment** – Missing features are looked up from the store; temporal windows are applied.  
3. **Score computation** – Model service returns `anomalyScore` ∈ [0,1].  
4. **Attribution** – SHAP values (`shapValues`) are computed per feature.  
5. **Counterfactual generation** – Minimal perturbations that would flip the score below the anomaly threshold.  
6. **Narrative synthesis** – A templated natural‑language summary (e.g., “High CPU usage combined with network latency caused a 0.92 anomaly correlation”).  
7. **Response** – JSON containing `score`, `explanations`, `counterfactuals`, and optional `visualizationUrl`.  

---  

## Quickstart  

### Prerequisites  

| Tool | Minimum Version |
|------|-----------------|
| Node.js | 18.x |
| npm / yarn | 8.x |
| Python | 3.10 |
| Docker (optional) | 20.10 |

### 1. Clone the repository  

```bash
git clone https://github.com/your-org/aces.git
cd aces
```

### 2. Install the Node.js gateway  

```bash
# Using npm
npm ci

# Or using Yarn
yarn install --frozen-lockfile
```

### 3. Set up the Python environment  

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r python/requirements.txt
```

### 4. Run the services (Docker‑Compose)  

```bash
docker compose up -d
# Services:
# - gateway (http://localhost:3000)
# - model (http://localhost:8000)
# - db (PostgreSQL)
```

### 5. Call the Explainability API  

```bash
# Save a sample payload
cat > payload.json <<EOF
{
  "entityId": "sensor-42",
  "timestamp": "2026-10-19T12:00:00Z",
  "features": {
    "cpu_usage": 0.87,
    "network_latency": 210,
    "temperature": 78
  }
}
EOF

# Request