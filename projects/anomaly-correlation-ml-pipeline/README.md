# Anomaly Correlation ML Pipeline
**Category:** Data Science  
**Stack:** TypeScript / Node.js  

An end‑to‑end pipeline that seamlessly connects data aggregation, time‑series forecasting, model training, evaluation, and a RESTful API for serving anomaly‑correlation predictions.

---

## Overview
The **Anomaly Correlation ML Pipeline** automates the full lifecycle of an anomaly‑detection model that not only flags outliers but also quantifies their correlation across multiple signals.  

Key capabilities:

| Feature | Description |
|---------|-------------|
| **Data Ingestion & Aggregation** | Pulls raw telemetry from CSV, Parquet, or streaming sources and aggregates to configurable windows (e.g., 5 min, 1 h). |
| **Feature Engineering** | Generates statistical, lag, and Fourier features; supports custom user‑defined transforms. |
| **Forecasting Backbone** | Uses Prophet‑style additive models (or any TensorFlow.js model) to produce baseline forecasts. |
| **Anomaly Scoring** | Computes residuals, applies robust statistical tests, and produces a correlation matrix of simultaneous anomalies. |
| **Model Training & Evaluation** | Trains a Gradient Boosted Tree (XGBoost via `xgboost-node`) to predict anomaly severity; evaluates with Precision‑Recall, ROC‑AUC, and a custom *Correlation‑F1* metric. |
| **API Layer** | Express‑based HTTP API exposing `/predict`, `/metrics`, and `/health` endpoints. |
| **Observability** | Integrated with Prometheus metrics and Loki logs; optional Grafana dashboards. |

The pipeline is modular, type‑safe, and fully configurable via a single `pipeline.config.ts` file.

---

## Theory & Architecture
### 1. Data Flow Diagram
```
┌─────────────┐   ┌─────────────────┐   ┌─────────────────────┐
│ Source(s)   │ → │ Aggregation     │ → │ Feature Engineering │
└─────────────┘   └─────────────────┘   └─────────────────────┘
                                                │
                                                ▼
                                         ┌───────────────┐
                                         │ Forecasting   │
                                         └───────┬───────┘
                                                 │
                                                 ▼
                                         ┌───────────────┐
                                         │ Residual Calc │
                                         └───────┬───────┘
                                                 │
                                                 ▼
                                         ┌───────────────┐
                                         │ Anomaly Score │
                                         └───────┬───────┘
                                                 │
                                                 ▼
                                         ┌───────────────┐
                                         │ Correlation   │
                                         │ Matrix Builder│
                                         └───────┬───────┘
                                                 │
                                                 ▼
                                         ┌───────────────┐
                                         │ Model Trainer │
                                         └───────┬───────┘
                                                 │
                                                 ▼
                                         ┌───────────────┐
                                         │ Evaluation    │
                                         └───────┬───────┘
                                                 │
                                                 ▼
                                         ┌───────────────┐
                                         │ API Service   │
                                         └───────────────┘
```

### 2. Core Algorithms
| Component | Algorithm | Rationale |
|-----------|-----------|-----------|
| **Forecasting** | Additive decomposition (trend + seasonality + holidays) using `prophet-node` | Handles irregular seasonality and missing data gracefully. |
| **Anomaly Scoring** | Median Absolute Deviation (MAD) on residuals + Z‑score clipping | Robust to heavy‑tailed noise while preserving sensitivity. |
| **Correlation** | Pearson + Spearman hybrid on binary anomaly masks across sensors | Captures both linear and monotonic relationships. |
| **Model** | Gradient Boosted Trees (XGBoost) | Handles heterogeneous features, provides feature importance, and works well with limited training data. |
| **Evaluation** | Custom *Correlation‑F1*: `2 * (Precision_corr * Recall_corr) / (Precision_corr + Recall_corr)` | Rewards models that correctly predict groups of simultaneous anomalies. |

### 3. TypeScript Architecture
- **`src/config/`** – Strongly typed configuration schemas (`zod` validation).  
- **`src/ingest/`** – Connectors (`CsvConnector`, `KafkaConnector`).  
- **`src/transform/`** – Pure functions returning `Promise<FeatureSet>`.  
- **`src/model/`** – Wrapper around XGBoost training (`ModelTrainer`) and inference (`ModelPredictor`).  
- **`src/api/`** – Express router with request validation (`express-validator`).  
- **`src/monitoring/`** – Prometheus client & Loki logger.  

All modules expose **interfaces** (`IDataSource`, `IFeatureEngine`, `IPredictor`) enabling easy swapping of implementations.