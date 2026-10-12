# Anomaly Correlation MLOps Orchestrator
**Category:** Data Science  
**Stack:** TypeScript / Node.js  

Automates model training, evaluation, and deployment pipelines for anomaly correlation.

---

## Table of Contents
- [Overview](#overview)
- [Theory & Architecture](#theory--architecture)
- [Quickstart](#quickstart)
- [Complexity Analysis](#complexity-analysis)
- [License](#license)

---

## Overview
The **Anomaly Correlation MLOps Orchestrator** is a lightweight, extensible framework that glues together the full lifecycle of anomaly‑detection models:

1. **Data Ingestion** – Pulls time‑series or event data from configurable sources (Kafka, S3, REST APIs, etc.).
2. **Feature Engineering** – Applies windowing, statistical transforms, and domain‑specific feature generators.
3. **Model Training** – Spins up containerised training jobs (TensorFlow, PyTorch, XGBoost) on local or cloud resources.
4. **Evaluation** – Computes correlation‑based metrics (e.g., Pearson, Spearman, Dynamic Time Warping) and alerts on drift.
5. **Deployment** – Packages the best model as a Docker image and registers it with a model‑serving gateway (e.g., KFServing, Seldon).
6. **Monitoring & Retraining** – Continuously monitors inference performance and triggers automated retraining when degradation crosses a threshold.

All steps are defined declaratively via a **pipeline manifest** (`pipeline.yaml`). The orchestrator parses the manifest, resolves dependencies, and executes each stage using a pluggable **Task Runner** (default: Node.js child processes, optional: Kubernetes Jobs).

---

## Theory & Architecture

### Core Concepts
| Concept | Description |
|---------|-------------|
| **Anomaly Correlation** | Quantifies how well predicted anomalies align temporally and magnitude‑wise with ground‑truth events using correlation coefficients and lag‑aware scoring. |
| **Pipeline Manifest** | YAML file describing data sources, feature pipelines, training hyper‑parameters, evaluation criteria, and deployment targets. |
| **Task Runner** | Abstract interface (`ITaskRunner`) that executes a step. Implementations: `LocalRunner`, `K8sJobRunner`, `AWSBatchRunner`. |
| **Model Registry** | Centralised store (e.g., MLflow, custom PostgreSQL) that tracks model artefacts, metrics, and version lineage. |

### High‑Level Architecture

```
+-------------------+       +-------------------+       +-------------------+
|   Data Connectors | ----> |   Feature Engine  | ----> |   Training Engine |
+-------------------+       +-------------------+       +-------------------+
          |                         |                           |
          v                         v                           v
+-------------------+       +-------------------+       +-------------------+
|   Evaluation Hub  | <---- |   Orchestrator    | ----> |   Deployment Hub  |
+-------------------+       +-------------------+       +-------------------+
          ^                         ^                           ^
          |                         |                           |
   +------+-----+            +------+-----+               +-----+------+
   | Monitoring |            | Scheduler |               | Registry   |
   +------------+            +-----------+               +------------+
```

1. **Orchestrator** reads `pipeline.yaml`, builds a DAG of tasks, and hands each node to the selected `ITaskRunner`.  
2. **Feature Engine** runs deterministic transforms; results are cached in a local artifact store to avoid recomputation.  
3. **Training Engine** launches containerised training jobs; logs and model checkpoints are streamed back to the orchestrator.  
4. **Evaluation Hub** loads the validation set, computes correlation metrics, and writes a `metrics.json` artifact.  
5. **Deployment Hub** builds a Docker image (`Dockerfile` generated on‑the‑fly) and pushes it to a registry; a Helm chart is rendered to expose the model as a REST endpoint.  
6. **Monitoring** continuously ingests inference logs, recomputes correlation drift, and triggers a new pipeline run if drift > `config.retrainThreshold`.

### Extensibility Points
- **Custom Feature Plugins** – Implement `IFeaturePlugin` and register in `plugins/`.
- **Alternative Correlation Metrics** – Add a new scorer under `metrics/` and reference it in the manifest.
- **Cloud‑Native Runners** – Extend `ITaskRunner` to target Azure ML, GCP AI Platform, etc.

---

## Quickstart

### Prerequisites
- Node.js ≥ 18
- Docker (for containerised training/deployment)
- Optional: Kubernetes cluster (for `K8sJob