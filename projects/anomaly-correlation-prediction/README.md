# Anomaly Correlation Prediction Engine  

**Category:** Data Science  
**Stack:** TypeScript • Node.js • TensorFlow.js  

Real‑time forecasting of anomaly scores using Kalman Filters, wrapped in a lightweight, production‑ready Node.js library.

---

## Overview  

The **Anomaly Correlation Prediction Engine (ACPE)** ingests streaming sensor or log data, applies a Kalman filter to smooth noisy observations, and predicts future anomaly scores with TensorFlow.js‑powered neural components.  

Key benefits  

- **Low latency** – end‑to‑end inference < 10 ms on commodity hardware.  
- **Statistical rigor** – Kalman filter provides optimal linear‑Gaussian estimation.  
- **Extensible** – plug‑in custom TensorFlow.js models for non‑linear residual correction.  
- **Type‑safe** – full TypeScript typings for IDE autocompletion and compile‑time safety.  

---

## Theory & Architecture  

### 1. Kalman Filter Core  

| Symbol | Meaning |
|--------|---------|
| **xₖ** | Hidden state vector at time *k* |
| **zₖ** | Observation (raw anomaly score) at time *k* |
| **A** | State transition matrix |
| **H** | Observation matrix |
| **Q** | Process noise covariance |
| **R** | Observation noise covariance |
| **Kₖ** | Kalman gain |

The filter follows the classic two‑step cycle:  

1. **Predict**  
   - `x̂ₖ⁻ = A * x̂ₖ₋₁`  
   - `Pₖ⁻ = A * Pₖ₋₁ * Aᵀ + Q`  

2. **Update**  
   - `Kₖ = Pₖ⁻ * Hᵀ * (H * Pₖ⁻ * Hᵀ + R)⁻¹`  
   - `x̂ₖ = x̂ₖ⁻ + Kₖ * (zₖ - H * x̂ₖ⁻)`  
   - `Pₖ = (I - Kₖ * H) * Pₖ⁻`  

### 2. TensorFlow.js Residual Model  

After linear Kalman smoothing, a lightweight TensorFlow.js model captures non‑linear residual patterns:

```
input  →  Dense(32, relu) → Dense(16, relu) → Dense(1, linear) → output
```

The residual is added back to the Kalman estimate to produce the final forecasted anomaly score.

### 3. System Diagram  

```
+-------------------+      +-------------------+      +-------------------+
|   Data Source(s)  | ---> |   Kalman Filter   | ---> |  TF.js Residual   |
+-------------------+      +-------------------+      +-------------------+
                                 |                         |
                                 v                         v
                         Smoothed state            Residual correction
                                 \_______________________/
                                             |
                                             v
                                   Forecasted Anomaly Score
```

### 4. Module Layout  

| Module | Responsibility |
|--------|-----------------|
| `src/kf.ts` | Pure‑TypeScript Kalman filter implementation |
| `src/model.ts` | TensorFlow.js model loader & inference wrapper |
| `src/engine.ts` | Orchestrates KF → residual → output, handles streaming API |
| `src/types.ts` | Shared interfaces (`Observation`, `State`, `Config`) |
| `test/` | Jest unit tests for numerical stability and model integration |

---

## Quickstart  

### Prerequisites  

- **Node.js** ≥ 18  
- **npm** or **yarn**  

```bash
# Clone the repo
git clone https://github.com/yourorg/acpe.git
cd acpe

# Install dependencies
npm install   # or yarn install
```

### Running the demo  

```bash
# Build TypeScript sources
npm run build

# Start the real‑time demo (emits a forecast every 500 ms)
npm start
```

You should see console output similar to:

```
[00:00:00.500] Observation: 0.73 → Forecast: 0.68
[00:00:01.000] Observation: 0.81 → Forecast: 0.79
...
```

### Embedding ACPE in your own project  

```typescript
import { AnomalyEngine, EngineConfig } from 'acpe';

// 1️⃣ Configure the engine
const config: EngineConfig = {
  kalman: {
    A: [[1]],
    H: [[1]],
    Q: [[0.001]],
    R: [[0.01]],
    initialState: [0],
    initialCovariance: [[1]],
  },
  tfModelPath: './models/residual-model.json',
};

// 2️⃣ Instantiate the engine
const engine = new AnomalyEngine(config);

// 3️⃣ Feed observations (e.g., from a sensor stream)
async function onNewScore(score: number) {
  const forecast = await engine.predict(score