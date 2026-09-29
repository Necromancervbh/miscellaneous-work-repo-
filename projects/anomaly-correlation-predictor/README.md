# Anomaly Correlation Predictive Engine  
**Category:** Data Science  
**Stack:** TypeScript • Node.js • TensorFlow.js  

**Description:**  
A lightweight, server‑side engine that predicts future anomalies in time‑series data by fusing a Kalman filter with Bayesian inference. Built with TypeScript and TensorFlow.js, it runs entirely in Node.js, making it easy to integrate into existing data pipelines or micro‑services.

---  

## Overview  

The Anomaly Correlation Predictive Engine (ACPE) continuously ingests streaming sensor or metric data, smooths it with a Kalman filter, and then estimates the probability of future anomalies using a Bayesian inference layer. The model is fully differentiable, allowing optional fine‑tuning with TensorFlow.js if labeled anomaly data becomes available.

Key features  

- **Real‑time processing** – O(1) per‑sample update using the Kalman filter.  
- **Probabilistic forecasts** – Bayesian posterior gives calibrated anomaly scores.  
- **Extensible** – Swap the inference module for a neural net or a custom prior.  
- **Zero external dependencies** – Runs on pure Node.js; no Python or native binaries required.  

---  

## Theory / Architecture  

```
+-------------------+      +-------------------+      +-------------------+
|   Input Stream    | ---> |   Kalman Filter   | ---> | Bayesian Inference|
| (raw measurements)|      | (state smoothing) |      | (posterior probs) |
+-------------------+      +-------------------+      +-------------------+
                                   |                         |
                                   v                         v
                         +-------------------+      +-------------------+
                         |  State Estimate   |      |  Anomaly Score    |
                         +-------------------+      +-------------------+
```

### 1. Kalman Filter  

- **State vector** `x_t` captures the underlying signal (e.g., trend, seasonality).  
- **Observation model** `z_t = H x_t + v_t` where `v_t ~ N(0, R)`.  
- **Prediction step:**  
  - `x̂_{t|t-1} = A x̂_{t-1|t-1}`  
  - `P_{t|t-1} = A P_{t-1|t-1} Aᵀ + Q`  
- **Update step:**  
  - `K_t = P_{t|t-1} Hᵀ (H P_{t|t-1} Hᵀ + R)^{-1}`  
  - `x̂_{t|t} = x̂_{t|t-1} + K_t (z_t - H x̂_{t|t-1})`  
  - `P_{t|t} = (I - K_t H) P_{t|t-1}`  

Implemented with TensorFlow.js tensors for GPU/CPU acceleration.

### 2. Bayesian Inference  

- **Prior** `p(θ)` encodes domain knowledge about anomaly frequency.  
- **Likelihood** `p(y_t | θ, x̂_t)` is modeled as a Bernoulli trial where `y_t` = 1 denotes an anomaly.  
- **Posterior** `p(θ | y_{1:t}) ∝ p(θ) ∏_{i=1}^{t} p(y_i | θ, x̂_i)` is approximated using a conjugate Beta distribution for analytical tractability.  

When labeled anomalies are available, the engine can optionally train a small feed‑forward network (`tf.sequential`) to learn a more expressive likelihood function.

### 3. API Flow  

1. **Initialize** the engine with model hyper‑parameters (`A, H, Q, R, α, β`).  
2. **Call** `engine.update(measurement)` for each new data point.  
3. **Retrieve** `engine.anomalyScore()` – a probability in `[0, 1]`.  
4. **Optionally** `engine.fit(labeledBatch)` to adapt the likelihood network.

---  

## Quickstart  

### Prerequisites  

```bash
# Node.js 18+ is required
npm install --save @tensorflow/tfjs-node anomaly-correlation-engine
```

### Minimal example  

```typescript
import { AnomalyEngine, EngineConfig } from 'anomaly-correlation-engine';

// 1️⃣ Configure the Kalman filter & Bayesian prior
const config: EngineConfig = {
  // Linear dynamics (simple random walk)
  A: [[1]],
  H: [[1]],
  Q: [[0.001]],
  R: [[0.01]],
  // Beta prior α=1, β=1 (uniform)
  priorAlpha: 1,
  priorBeta: 1,
  // Optional neural likelihood (disabled by default)
  useNeuralLikelihood: false,
};

const engine = new AnomalyEngine(config);

// 2️⃣ Simulate a stream of measurements
const measurements = [0.12, 0.15, 0.14, 0.80, 0.18, 0.20];

measurements.forEach((value, idx) => {
  engine.update(value);                     // Kalman filter update + Bayesian step
  const prob = engine.anomalyScore