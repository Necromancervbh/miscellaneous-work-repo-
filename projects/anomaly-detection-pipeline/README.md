# Real‑Time Anomaly Detection Pipeline  
**Category:** Data Science  
**Stack:** TypeScript / Node.js  

---  

## Overview  

The **Real‑Time Anomaly Detection Pipeline** is a streaming ETL (Extract‑Transform‑Load) framework that continuously ingests raw event streams, aggregates metrics, applies statistical and machine‑learning filters, and pushes detected anomalies to a live dashboard.  

Key capabilities  

- **Zero‑downtime ingestion** from Kafka, Kinesis, or any WebSocket source.  
- **Windowed aggregation** (tumbling, sliding, session) using RxJS operators.  
- **Pluggable anomaly detectors** (z‑score, Isolation Forest, custom TensorFlow.js models).  
- **Real‑time visualization** via a lightweight Express + Socket.io UI.  
- **Extensible architecture** – add new sources, transforms, or sinks with a single TypeScript interface.  

---  

## Theory / Architecture  

```
+-------------------+      +-------------------+      +-------------------+
|   Event Sources   | ---> |   Stream Engine   | ---> |   Anomaly Engine  |
| (Kafka, Kinesis, |      | (RxJS + Node.js)  |      | (TS/JS detectors) |
|  WebSocket, …)   |      +-------------------+      +-------------------+
+-------------------+                |                         |
                                      v                         v
                               +-------------------+   +-------------------+
                               |   Aggregator      |   |   Filter/Enrich   |
                               | (windowed stats) |   | (outlier rules)   |
                               +-------------------+   +-------------------+
                                      |                         |
                                      v                         v
                               +-------------------+   +-------------------+
                               |   Persistence     |   |   Real‑time UI    |
                               | (Redis / ClickHouse) | (Socket.io + D3) |
                               +-------------------+   +-------------------+
```

### Core Concepts  

| Concept | Description |
|---------|-------------|
| **SourceAdapter** | Implements `IEventSource` – abstracts connection, back‑pressure handling, and reconnection logic. |
| **StreamEngine** | Central RxJS pipeline (`Observable<Event>`). Handles throttling, error handling, and graceful shutdown. |
| **WindowAggregator** | Uses `windowTime`, `bufferCount`, etc., to compute rolling statistics (mean, variance, quantiles). |
| **Detector** | Implements `IAnomalyDetector`. Returns `AnomalyResult` objects containing score, severity, and context. |
| **SinkAdapter** | Pushes anomalies to Redis streams, ClickHouse tables, or directly to the UI via Socket.io. |
| **Dashboard** | Minimal Express server serving a single‑page React/D3 app that updates in < 200 ms after detection. |

### Data Flow  

1. **Ingestion** – `SourceAdapter` emits raw events (`Event` interface).  
2. **Pre‑processing** – optional schema validation & enrichment.  
3. **Aggregation** – `WindowAggregator` computes per‑key metrics (e.g., count per minute, moving average).  
4. **Detection** – each window is fed to one or more `IAnomalyDetector` instances.  
5. **Post‑processing** – severity scoring, deduplication, and correlation.  
6. **Persistence & Notification** – results are stored and emitted to the UI in real time.  

---  

## Quickstart  

### Prerequisites  

- Node.js **>=18.x** (supports native ES modules)  
- Yarn or npm  
- (Optional) Docker for Kafka/Redis if you want to run the full stack locally  

### Installation  

```bash
# Clone the repo
git clone https://github.com/yourorg/real-time-anomaly-pipeline.git
cd real-time-anomaly-pipeline

# Install dependencies
yarn install   # or npm ci

# Build TypeScript sources
yarn build
```

### Run a minimal demo  

The demo uses an in‑process mock source that emits synthetic sensor readings.

```bash
# Start the pipeline (includes UI on http://localhost:3000)
yarn start:demo
```

#### Code example (programmatic usage)

```ts
import { Pipeline } from "./src/pipeline";
import { MockSource } from "./src/sources/mock";
import { ZScoreDetector } from "./src/detectors/zscore";
import { SocketSink } from "./src/sinks/socket";

// 1️⃣ Create a source that emits { id: string, value: number, ts: number }
const source = new MockSource({ rate: 1000 }); // 1k events/sec

// 2️⃣ Configure a detector (z‑score > 3 triggers an anomaly)
const detector = new ZScoreDetector({ windowMs: 30_000, threshold: 3 });

// 3️⃣ Wire up a sink that pushes anomalies to the live UI
const uiSink = new SocketSink({ port: 3000 });

// 4️⃣ Assemble