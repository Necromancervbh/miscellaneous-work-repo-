# Anomaly Correlation Data Ingestion Service
**Category:** Data Science  
**Stack:** TypeScript / Node.js  

Stream, clean, and enrich sensor streams for downstream anomaly services.

---

## Overview
The **Anomaly Correlation Data Ingestion Service** (ACDIS) is a lightweight, high‑throughput Node.js application written in TypeScript. It connects to one or many sensor data sources (Kafka, MQTT, HTTP, etc.), performs real‑time validation, normalization, and feature enrichment, then forwards the processed payloads to downstream anomaly detection pipelines.

Key capabilities:

| Feature | Description |
|---------|-------------|
| **Multi‑protocol ingestion** | Supports Kafka, MQTT, WebSocket, and plain HTTP POST streams. |
| **Schema‑driven validation** | Uses JSON Schema + AJV for fast, deterministic validation. |
| **Temporal enrichment** | Adds rolling statistics (mean, std, min, max) and lagged values. |
| **Back‑pressure handling** | Built‑in buffering with configurable watermarks. |
| **Observability** | Prometheus metrics, structured logs (pino), and OpenTelemetry traces. |
| **Extensible plugins** | Drop‑in processors for custom feature engineering. |

The service is deliberately stateless aside from optional in‑memory windows, making horizontal scaling trivial with Kubernetes or any container orchestrator.

---

## Theory / Architecture
```
+-------------------+       +-------------------+       +-------------------+
|   Sensor Sources  | --->  |   Ingestion Layer | --->  |   Enrichment Layer|
+-------------------+       +-------------------+       +-------------------+
                                 |                         |
                                 v                         v
                         +-------------------+   +-------------------+
                         |   Validation      |   |   Feature Engine  |
                         |   (AJV)           |   |   (TS)            |
                         +-------------------+   +-------------------+
                                 |                         |
                                 v                         v
                         +-------------------+   +-------------------+
                         |   Buffer / Queue  |   |   Metrics & Logs  |
                         +-------------------+   +-------------------+
                                 |                         |
                                 v                         v
                         +-------------------+   +-------------------+
                         |   Output Adapter  |   |   Health Checks   |
                         +-------------------+   +-------------------+
                                 |
                                 v
                         +-------------------+
                         | Downstream Anomaly|
                         |   Service(s)      |
                         +-------------------+
```

### Core Components
1. **Ingestion Layer** – Abstracts transport specifics behind a unified `IDataSource` interface. Each source implements `connect()`, `listen()`, and `disconnect()`.
2. **Validation** – Compiles a JSON Schema at startup. Incoming messages are validated synchronously; invalid payloads are routed to a dead‑letter queue.
3. **Feature Engine** – Maintains per‑sensor sliding windows (configurable size). Computes:
   * Rolling mean, variance, min, max  
   * Lagged values (`t‑1`, `t‑2`)  
   * Domain‑specific transformations (e.g., temperature → dew point)
4. **Buffer / Queue** – Uses `node:stream` pipelines with back‑pressure propagation. Optional Redis or RabbitMQ can be swapped in via the `IQueueAdapter` interface.
5. **Output Adapter** – Serializes enriched records to the target (Kafka topic, HTTP endpoint, gRPC stream, etc.).
6. **Observability** – Exposes `/metrics` (Prometheus) and `/healthz`. Logs are emitted in JSON format for easy ingestion by ELK/EFK stacks.

### Data Flow
1. **Receive** raw sensor JSON.  
2. **Validate** against schema → discard or dead‑letter on failure.  
3. **Enrich** with temporal features and any user‑defined plugins.  
4. **Publish** enriched record downstream.  

All steps are non‑blocking; the only synchronous operation is schema validation, which runs in < 0.2 ms per record on a typical 2 GHz CPU.

---

## Quickstart
### Prerequisites
- Node.js ≥ 18  
- Yarn or npm  
- (Optional) Docker & Docker Compose for local Kafka/MQTT broker

### Installation
```bash
# Clone the repo
git clone https://github.com/your-org/acdis.git
cd acdis

# Install dependencies
yarn install   # or npm ci

# Build TypeScript sources
yarn build     # or npm run build
```

### Configuration
Create a `.env` file (or export env vars) with at least the following keys:

```dotenv
# Ingestion
DATA_SOURCE=kafka          # kafka | mqtt | http
KAFKA_BROKERS=localhost:9092
KAFKA_TOPIC=sensor.raw

# Validation
SCHEMA_PATH=./schemas/sensor.json

# Enrichment
WINDOW_SIZE=60            # seconds for rolling stats
LAG_COUNT=3               # number of lagged values to emit

# Output
OUTPUT_ADAPTER=kafka
OUTPUT_TOPIC=sensor.enriched
```

### Run locally
```bash
# Start a local Kafka broker (optional, requires Docker)
docker-compose up -d kafka

# Launch the service
yarn start   # or npm start
```

### Minimal Code Example
Below is a minimal programmatic