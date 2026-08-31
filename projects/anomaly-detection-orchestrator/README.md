# Anomaly Detection Orchestrator
**Category:** Full‑Stack  
**Stack:** Node.js • TypeScript • WebSocket  

Unified API that merges **Seasonal‑Trend‑Loess (STL)** and **Kalman filter** based anomaly detection, delivering real‑time streaming insights over WebSocket connections.

---

## Overview
The Anomaly Detection Orchestrator (ADO) provides a single, type‑safe endpoint for ingesting time‑series data, applying both STL decomposition and Kalman filtering, and streaming back detected anomalies as they occur.  

Key features:

- **Hybrid detection** – combines the robustness of STL (seasonality/trend) with the predictive power of Kalman filters.
- **Real‑time streaming** – results are pushed to clients via WebSocket, eliminating polling latency.
- **Extensible API** – plug‑in architecture for additional detectors or custom preprocessing steps.
- **Type‑safe contracts** – full TypeScript definitions for request/response payloads.
- **Scalable** – stateless request handling enables horizontal scaling behind a load balancer.

---

## Theory & Architecture

### 1. Detection Pipeline
```
┌─────────────────┐
│  WebSocket API  │
└───────┬─────────┘
        │
        ▼
┌─────────────────┐   ┌─────────────────────┐
│  Input Buffer   │──►│  STL Decomposition   │
└───────┬─────────┘   └───────┬─────────────┘
        │                     │
        ▼                     ▼
┌─────────────────┐   ┌─────────────────────┐
│  Kalman Filter  │◄──│  Residual Extraction│
└───────┬─────────┘   └───────┬─────────────┘
        │                     │
        ▼                     ▼
┌─────────────────┐   ┌─────────────────────┐
│  Anomaly Scorer │──►│  Alert Generator    │
└───────┬─────────┘   └───────┬─────────────┘
        │                     │
        ▼                     ▼
   ┌─────────────┐        ┌─────────────┐
   │  WebSocket │◄───────│  Client(s)  │
   └─────────────┘        └─────────────┘
```

1. **Input Buffer** – batches incoming points (default 1 s window) to smooth bursty traffic.  
2. **STL Decomposition** – extracts seasonal, trend, and remainder components using LOESS smoothing.  
3. **Kalman Filter** – predicts the next value based on a linear state‑space model; the residual (observation – prediction) is fed back to STL.  
4. **Anomaly Scorer** – computes Z‑scores on STL remainder and Kalman residuals, then fuses them via weighted geometric mean.  
5. **Alert Generator** – thresholds the fused score, creates a structured anomaly event, and pushes it over the active WebSocket.

### 2. Core Modules
| Module | Responsibility | Key Types |
|--------|----------------|-----------|
| `api/ws.ts` | WebSocket server, connection lifecycle | `WsMessage`, `WsClient` |
| `pipeline/buffer.ts` | Time‑window aggregation | `DataPoint`, `Batch` |
| `detectors/stl.ts` | Seasonal‑Trend‑Loess logic | `StlResult` |
| `detectors/kalman.ts` | Linear‑Gaussian state estimator | `KalmanState` |
| `fusion/scorer.ts` | Score fusion & thresholding | `AnomalyScore` |
| `models/event.ts` | Public anomaly event schema | `AnomalyEvent` |

All modules expose **pure functions** where possible, making them unit‑testable and reusable outside the orchestrator.

### 3. Data Flow (TypeScript Interfaces)

```ts
// Incoming measurement
export interface DataPoint {
  timestamp: number;      // epoch ms
  value: number;
  seriesId: string;       // identifier for the time‑series
}

// STL output
export interface StlResult {
  seasonal: number;
  trend: number;
  remainder: number;
}

// Kalman output
export interface KalmanState {
  estimate: number;
  covariance: number;
}

// Fusion result
export interface AnomalyScore {
  stlZ: number;
  kalmanZ: number;
  fused: number;
}

// Event sent to client
export interface AnomalyEvent {
  seriesId: string;
  timestamp: number;
  score: number;
  severity: 'low' | 'medium' | 'high';
  details: {
    stlZ: number;
    kalmanZ: number;
  };
}
```

---

## Quickstart

### Prerequisites
- **Node.js** ≥ 18
- **npm