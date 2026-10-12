# Forecasting Engine  

**Category:** Data Science  
**Stack:** Node.js / TypeScript  

Predict future anomalies in time‑series data by combining Seasonal‑Trend decomposition using Loess (STL) with a Kalman filter. The engine ingests raw observations, extracts seasonal/trend components, and continuously updates a state‑space model to forecast and flag anomalous points.

---  

## Overview  

The Forecasting Engine is a lightweight, production‑ready library for Node.js that:

* **Decomposes** raw series into seasonal, trend, and residual components using STL.  
* **Filters** the residuals with a Kalman filter to produce optimal one‑step‑ahead forecasts.  
* **Detects anomalies** by comparing forecast errors against configurable confidence bounds.  
* **Runs** entirely in TypeScript, making it easy to integrate with modern JavaScript back‑ends or serverless functions.  

Typical use‑cases:

* IoT sensor streams (temperature, vibration, etc.)  
* Business KPI monitoring (traffic, sales, error rates)  
* Predictive maintenance dashboards  

---  

## Theory & Architecture  

### 1. STL Decomposition  

STL (Seasonal‑Trend decomposition using Loess) separates a time series `y[t]` into three additive components:

```
y[t] = Seasonal[t] + Trend[t] + Residual[t]
```

* **Seasonal** – captures repeating patterns (hourly, daily, weekly).  
* **Trend** – smooth long‑term direction using locally weighted regression.  
* **Residual** – the remaining noise, which is fed to the Kalman filter.

STL is robust to outliers and works with irregular timestamps, making it ideal for streaming data.

### 2. Kalman Filter  

The Kalman filter models the residuals as a linear Gaussian state‑space system:

```
x[t]   = A * x[t‑1] + w[t]      (state transition)
z[t]   = H * x[t]   + v[t]      (observation)
w[t] ~ N(0, Q)                  (process noise)
v[t] ~ N(0, R)                  (measurement noise)
```

* **Prediction** – estimates the next state `x̂[t|t‑1]` and covariance `P[t|t‑1]`.  
* **Update** – incorporates the new residual `z[t]` to produce the posterior `x̂[t|t]`.  

The filter yields the optimal minimum‑mean‑square‑error forecast `ŷ[t+1]` and an associated uncertainty `σ[t+1]`.  

### 3. Anomaly Detection  

An observation is flagged as anomalous when the absolute forecast error exceeds a configurable multiple of the predicted standard deviation:

```
|y[t] - ŷ[t]| > λ * σ[t]   →   anomaly
```

`λ` defaults to `3` (≈99.7 % confidence for a Gaussian error model) but can be tuned per domain.

### 4. Architecture Diagram  

```
┌─────────────────────┐
│  Input Time‑Series   │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐   STL   ┌─────────────────────┐
│   STL Decomposer     ├──────►│  Seasonal / Trend   │
└─────────┬───────────┘        │  Components (opt.) │
          │                    └───────┬─────────────┘
          ▼                            │
┌─────────────────────┐                ▼
│   Residual Stream   │      Kalman Filter (TS)   ──►  Forecast + σ
└─────────┬───────────┘                │
          │                            ▼
          ▼                     Anomaly Detector
┌─────────────────────┐                │
│  Forecast Engine   │◄───────────────┘
└─────────────────────┘
```

All modules are pure TypeScript classes with no external native dependencies, enabling easy bundling with Webpack, Rollup, or serverless packaging tools.

---  

## Quickstart  

### 1. Install  

```bash
npm i @forecasting/engine
# or with yarn
yarn add @forecasting/engine
```

### 2. Basic Usage  

```typescript
import { ForecastEngine, EngineConfig } from '@forecasting/engine';

// 1️⃣  Configure the engine
const config: EngineConfig = {
  stl: {
    period: 24,            // e.g., hourly data with daily seasonality
    seasonal: { loessSpan: 0.1 },
    trend: { loessSpan: 0.3 },
    robust: true,
  },
  kalman: {
    A: 1,                  // simple random‑walk model
    H: 1,
    Q: 0.0001,             // process noise variance
    R: 0.01,               // measurement noise