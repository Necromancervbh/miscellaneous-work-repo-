# Anomaly Correlation Alerting Service
**Category:** Data Science  
**Stack:** Node.js • TypeScript • WebSocket  

Real‑time alerts for correlated anomalies across multiple data streams.

---  

## Overview
The **Anomaly Correlation Alerting Service (ACAS)** continuously ingests timestamped events from arbitrary data sources, detects anomalous patterns, and emits alerts when anomalies **co‑occur** or **correlate** across distinct streams.  

Key features:

| Feature | Description |
|---------|-------------|
| **Multi‑stream ingestion** | Connect via WebSocket, HTTP POST, or custom adapters. |
| **Statistical & ML‑based detection** | Built‑in z‑score, EWMA, and plug‑in model hooks. |
| **Correlation engine** | Sliding‑window Pearson, Spearman, and custom similarity metrics. |
| **Real‑time alerts** | Pushes JSON alerts over WebSocket to subscribed clients. |
| **Extensible** | TypeScript interfaces for custom detectors, aggregators, and alert handlers. |
| **Observability** | Prometheus metrics, structured logs, and optional Grafana dashboards. |

The service is designed to be deployed as a lightweight Node.js process that can run on a single VM or be scaled horizontally behind a load balancer.

---  

## Theory & Architecture
### 1. Data Flow
```
[Source] → WebSocket/HTTP → Ingestion Layer → Buffer (RingQueue) → Detector(s) → Correlation Engine → Alert Dispatcher → [Client]
```

1. **Ingestion Layer**  
   - Normalises incoming payloads (`{ streamId, timestamp, value }`).  
   - Performs back‑pressure handling via a bounded ring buffer.

2. **Detectors**  
   - Stateless statistical detectors (z‑score, EWMA).  
   - Optional stateful ML models (e.g., Isolation Forest) loaded as separate workers.

3. **Correlation Engine**  
   - Maintains a **time‑aligned window** per stream (`W = 30s` by default).  
   - Computes pairwise correlation scores `ρ(i, j)` using the selected metric.  
   - Triggers an alert when `ρ(i, j) ≥ τ_corr` **and** both streams flagged as anomalous.

4. **Alert Dispatcher**  
   - Formats alerts (`{ alertId, streams, correlation, timestamp, payload }`).  
   - Broadcasts via WebSocket to all subscribed clients.  
   - Optionally forwards to external systems (Kafka, HTTP webhook).

### 2. Core Data Structures
| Structure | Purpose | Complexity |
|-----------|---------|------------|
| `RingQueue<T>` | Fixed‑size circular buffer for each stream | `O(1)` enqueue/dequeue |
| `Map<string, StreamState>` | Holds per‑stream statistics (mean, variance, EWMA) | `O(1)` lookup |
| `CorrelationMatrix` | Symmetric matrix of recent correlation scores | `O(N²)` memory for `N` active streams |

### 3. Extensibility Points
- **`IDetector`** – implement `detect(event): boolean`.  
- **`ICorrelationMetric`** – implement `compute(seriesA, seriesB): number`.  
- **`IAlertSink`** – push alerts to DB, email, Slack, etc.

---  

## Quickstart
### Prerequisites
- Node.js **>= 18**  
- Yarn or npm  
- (Optional) Docker for containerised run  

### 1. Clone & Install
```bash
git clone https://github.com/yourorg/anomaly-correlation-alerting-service.git
cd anomaly-correlation-alerting-service
yarn install   # or npm ci
```

### 2. Run locally
```bash
# Build TypeScript sources
yarn build

# Start the service (default WS port 8080)
yarn start
```

You should see:

```
[INFO] ACAS listening on ws://0.0.0.0:8080
[INFO] Metrics exposed at http://localhost:9090/metrics
```

### 3. Connect a client & send data
```typescript
// client.ts
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:8080');

// Subscribe to alerts
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'subscribe', streams: ['sensor-A', 'sensor-B'] }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.type === 'alert') {
    console.log('🚨 Correlated anomaly alert:', msg);
  }
});

// Simulate a stream of values
function sendEvent(streamId: string, value: number) {
  ws.send(JSON.stringify({
    type: 'event',
    streamId,
    timestamp: Date.now(),
    value,
  }));
}

// Emit normal data
setInterval(() => sendEvent('sensor-A', Math.random() * 10), 500