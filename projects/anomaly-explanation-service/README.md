# Anomaly Explanation Service

**Category:** Data Science  
**Stack:** TypeScript / Node.js / Machine Learning  

Generates root‑cause insights for detected anomalies, turning raw alerts into actionable explanations that help data scientists and engineers quickly diagnose and remediate issues.

---

## Overview

The **Anomaly Explanation Service** (AES) is a lightweight, extensible Node.js library that:

- Consumes anomaly detection results (e.g., timestamps, metric values, and severity scores).
- Applies statistical and ML‑based techniques to infer the most probable root causes.
- Returns human‑readable explanations, feature importance scores, and optional visualizations.
- Can be deployed as a standalone micro‑service or embedded directly into existing pipelines.

Key benefits:

| Feature | Benefit |
|---------|----------|
| **Type‑safe API** | Full TypeScript typings for compile‑time safety. |
| **Modular architecture** | Swap out explanation models (SHAP, LIME, rule‑based) with a plug‑and‑play interface. |
| **Zero‑dependency inference** | Core logic runs without heavy ML frameworks; optional TensorFlow.js integration for deep models. |
| **Scalable** | Designed for both single‑request usage and high‑throughput batch processing. |

---

## Theory / Architecture

### 1. Data Flow

```
[ Anomaly Detector ] ──► (Anomaly Event) ──► AES ──► Explanation Result
```

1. **Input Payload** – JSON containing the anomaly context (metric name, timestamp, observed value, detection score, and a snapshot of related features).  
2. **Pre‑processing** – Normalisation, missing‑value handling, and feature engineering (e.g., lag features, rolling statistics).  
3. **Explanation Engine** – One of the following strategies (selected at runtime):
   - **Statistical Correlation** – Pearson / Spearman correlation with recent feature history.  
   - **Model‑agnostic SHAP/LIME** – Approximate contribution of each feature to the anomaly score.  
   - **Rule‑based Heuristics** – Domain‑specific thresholds and pattern matching.  
4. **Post‑processing** – Ranking of contributors, confidence scoring, and optional natural‑language templating.  
5. **Output** – Structured JSON + optional Markdown/HTML snippet for reporting.

### 2. Core Components

| Component | Description |
|-----------|-------------|
| `AnomalyPayload` | TypeScript interface describing the incoming anomaly data. |
| `Preprocessor` | Handles scaling, imputation, and feature extraction. |
| `IExplanationModel` | Interface that all explanation strategies implement (`explain(payload): Explanation`). |
| `StatisticalModel` | Fast correlation‑based engine (O(N · F) where *F* = number of features). |
| `ShapModel` | Wrapper around SHAP values (uses TensorFlow.js if a deep model is supplied). |
| `RuleEngine` | Configurable rule set expressed in JSON/YAML. |
| `ExplanationFormatter` | Turns raw scores into human‑readable sentences and visual aids. |
| `Server` (optional) | Express‑based HTTP endpoint exposing `/explain` for remote calls. |

### 3. Extensibility

To add a new explanation technique:

1. Implement `IExplanationModel`.  
2. Register the class in `ModelRegistry`.  
3. Update configuration (`models.enabled`) to include the new model.  

The service will automatically route incoming requests to the selected model(s) without code changes elsewhere.

---

## Quickstart

### Prerequisites

- Node.js ≥ 18  
- npm or Yarn  
- (Optional) Python environment if you want to generate SHAP values with a pre‑trained TensorFlow model.

### Installation

```bash
npm install anomaly-explanation-service
# or
yarn add anomaly-explanation-service
```

### Basic Usage (Embedded)

```typescript
import { AnomalyExplanationService, AnomalyPayload } from 'anomaly-explanation-service';

// 1️⃣ Create the service (default uses statistical + rule‑based models)
const aes = new AnomalyExplanationService({
  models: {
    enabled: ['statistical', 'rules'],
    // optional: custom model registration
    // custom: [{ name: 'myModel', instance: new MyModel() }]
  },
  ruleConfigPath: './config/rules.yaml',
});

// 2️⃣ Prepare an anomaly payload (usually produced by your detector)
const payload: AnomalyPayload = {
  metric: 'cpu_utilization',
  timestamp: '2026-09-01T12:34:56Z',
  observed: 92.4,
  score: 0.97,
  features: {
    host: 'web-01',
    region: 'us-east-1',
    avg_5min: 78.1,
    max_1h: 95.2,
    deployment_version: 'v2.3.1',
    // ...any additional context
  },
};

// 3️⃣ Request an explanation
aes.explain(payload