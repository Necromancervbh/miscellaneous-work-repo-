# Anomaly Correlation Aggregator

**Category:** Data Science  
**Stack:** Node.js, TypeScript, TensorFlow.js  

Aggregates multi‑sensor anomalies using a Kalman filter for temporal smoothing and DBSCAN for spatial clustering, delivering a unified view of correlated outliers across heterogeneous data streams.

---

## Overview

Modern IoT and industrial systems generate massive streams of sensor data. Detecting anomalies in isolation often yields noisy alerts, while correlated anomalies across sensors can indicate critical events (e.g., equipment failure, security breach).  

The **Anomaly Correlation Aggregator** (ACA) provides a plug‑and‑play library that:

- **Ingests** time‑series data from any number of sensors (numeric, categorical, or image‑based embeddings).  
- **Smooths** each sensor’s raw anomaly scores with a Kalman filter to reduce false positives caused by transient noise.  
- **Clusters** the filtered anomalies across sensors using DBSCAN, automatically discovering groups of co‑occurring outliers without needing a predefined number of clusters.  
- **Exports** aggregated anomaly groups with timestamps, contributing sensor IDs, and confidence scores for downstream alerting or visualization pipelines.

Built on **Node.js** and **TypeScript**, ACA leverages **TensorFlow.js** for efficient matrix operations and can run both on the server (Node) and in the browser.

---

## Theory & Architecture

### 1. Data Flow

```
[Raw Sensor Streams] → [Anomaly Scorers] → [Kalman Filter] → [DBSCAN] → [Aggregated Alerts]
```

1. **Raw Sensor Streams** – Any source that emits timestamped readings (e.g., MQTT, HTTP, file).  
2. **Anomaly Scorers** – User‑provided functions or pre‑trained TensorFlow.js models that output a scalar anomaly score per reading.  
3. **Kalman Filter** – A linear‑Gaussian estimator applied per sensor to produce a smoothed posterior estimate of the anomaly score.  
4. **DBSCAN** – Density‑based clustering on the multi‑dimensional vector `[timestamp, sensorId, smoothedScore]`.  
5. **Aggregated Alerts** – JSON payloads summarizing each cluster.

### 2. Kalman Filter Details

- **State Vector** `x_k = [s_k, v_k]ᵀ` where `s_k` is the smoothed anomaly score and `v_k` its velocity.  
- **Process Model** `x_{k+1} = A·x_k + w_k`, with `A = [[1, Δt], [0, 1]]`.  
- **Observation Model** `z_k = H·x_k + v_k`, where `H = [1, 0]`.  
- **Covariances** `Q` (process) and `R` (measurement) are configurable per sensor, allowing adaptive smoothing for high‑frequency vs. low‑frequency streams.

### 3. DBSCAN Adaptation

- **Feature Space**: `(t_norm, s_norm, id_onehot…)` – timestamps are normalized to a sliding window, scores are z‑scored, and sensor IDs are one‑hot encoded.  
- **Parameters**:  
  - `ε` (epsilon) – controls temporal‑spatial proximity.  
  - `minPts` – minimum number of points to form a cluster (default 3).  
- **Implementation**: Utilizes TensorFlow.js tensors for batch distance calculations, enabling GPU acceleration when available.

### 4. Module Structure

| Module | Responsibility |
|--------|----------------|
| `src/ingest/` | Connectors & adapters for various data sources. |
| `src/scorer/` | Interfaces for custom anomaly scorers; includes a simple statistical scorer. |
| `src/kalman/` | Generic Kalman filter class (`KalmanFilter<T>`). |
| `src/clustering/` | DBSCAN implementation (`DBSCANClusterer`). |
| `src/aggregator/` | Orchestrates the pipeline, emits `AggregatedAlert` objects. |
| `src/types/` | Shared TypeScript interfaces (`SensorReading`, `AnomalyScore`, `AggregatedAlert`). |
| `examples/` | Ready‑to‑run demos (Node script, browser demo). |

---

## Quickstart

### Prerequisites

- **Node.js** ≥ 18  
- **npm** or **yarn**  
- (Optional) GPU‑enabled TensorFlow.js runtime (`@tensorflow/tfjs-node-gpu`)

### Installation

```bash
# Install the core library
npm install anomaly-correlation-aggregator

# Install optional TensorFlow.js backend (CPU is default)
npm install @tensorflow/tfjs-node   # CPU
# npm install @tensorflow/tfjs-node-gpu   # GPU
```

### Minimal Example (Node)

```typescript
import { Aggregator, KalmanFilter, DBSCANClusterer } from 'anomaly-correlation-aggregator';
import * as tf from '@tensorflow/tfjs-node';

// 1️⃣ Define a simple statistical anomaly scorer
function z