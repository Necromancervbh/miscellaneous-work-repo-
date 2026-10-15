# Anomaly Correlation Data Ingestion Service

**Category:** Data Science  
**Stack:** Node.js / TypeScript  

**Description:**  
A lightweight, high‑throughput service that ingests raw sensor streams, applies preprocessing (filtering, normalization, feature extraction), and forwards the cleaned data to downstream anomaly‑detection pipelines. Designed for scalability, fault tolerance, and easy integration with modern data‑science workflows.

---

## Overview

The **Anomaly Correlation Data Ingestion Service** (ACDIS) solves three core problems:

1. **Reliable ingestion** – Handles bursty sensor traffic via back‑pressure‑aware streams.
2. **Preprocessing** – Performs deterministic transformations (e.g., missing‑value imputation, z‑score normalization, rolling‑window feature extraction) in a streaming fashion.
3. **Streaming output** – Publishes processed records to a configurable sink (Kafka, MQTT, HTTP webhook, etc.) for real‑time anomaly detection.

Key features:

- **Type‑safe** API built with TypeScript.
- **Pluggable adapters** for input sources and output sinks.
- **Config‑driven pipelines** – add, reorder, or disable preprocessing steps without code changes.
- **Observability** – built‑in metrics (Prometheus), structured logging (pino), and health checks.

---

## Theory / Architecture

```
+----------------+      +-------------------+      +-------------------+
|   Sensor(s)    | ---> |   Ingestion Layer | ---> |   Preprocessors   |
+----------------+      +-------------------+      +-------------------+
                                 |                         |
                                 v                         v
                         +-------------------+   +-------------------+
                         |   Buffer (Back‑   |   |   Feature Engine |
                         |   pressure Queue) |   +-------------------+
                         +-------------------+            |
                                 |                       v
                                 v                +-------------------+
                         +-------------------+    |   Normalizer      |
                         |   Sink Adapter    |<---|   (z‑score, etc.) |
                         +-------------------+    +-------------------+
                                 |
                                 v
                         +-------------------+
                         |   Destination(s)  |
                         | (Kafka, MQTT, …)  |
                         +-------------------+
```

### Core Components

| Component | Responsibility | Implementation Highlights |
|-----------|----------------|---------------------------|
| **Ingestion Layer** | Accepts HTTP, WebSocket, or raw TCP streams; validates schema using `ajv` | Uses `fastify` with `fastify-websocket`; schema validation is compiled once at startup. |
| **Back‑Pressure Queue** | Buffers incoming records; applies `highWater/lowWater` thresholds to trigger flow control | Implemented with `node:stream` `Transform` + `async‑iterator` interface. |
| **Preprocessors** | Chainable transforms (filter, impute, normalize, feature extraction) | Each step implements `Processor<T>` interface; can be hot‑reloaded via config reload. |
| **Sink Adapter** | Publishes processed records to the chosen sink; retries with exponential back‑off | Abstract `Sink` class; concrete `KafkaSink`, `MqttSink`, `HttpSink`. |
| **Observability** | Metrics, logs, health endpoints | `prom-client` for metrics, `pino` for JSON logs, `/healthz` & `/readyz` routes. |

### Data Flow

1. **Ingress** – Raw JSON payloads are parsed and validated.
2. **Queueing** – Records enter an async queue that respects downstream back‑pressure.
3. **Processing** – Each record passes through the configured processor chain.
4. **Emission** – The final record is serialized and sent to the sink; failures trigger retries and dead‑letter routing.

---

## Quickstart

### Prerequisites

- Node.js >= 18
- Yarn or npm
- (Optional) Docker for running a local Kafka broker

### Installation

```bash
# Clone the repo
git clone https://github.com/yourorg/anomaly-correlation-ingest.git
cd anomaly-correlation-ingest

# Install dependencies
yarn install   # or npm ci
```

### Configuration

Create a `config.yaml` (or edit the provided example) to define sources, processors, and sinks:

```yaml
ingestion:
  http:
    port: 3000
    schema: ./schemas/sensor-event.json

processors:
  - type: filter
    condition: "payload.value !== null"
  - type: impute
    strategy: "median"
  - type: normalize
    method: "zscore"
  - type: rollingFeature
    windowSize: 30   # seconds
    features:
      - mean
      - stddev

sink:
  type: kafka
  brokers:
    - localhost:9092
  topic: processed-sensor-data
  retry:
    maxAttempts: 5
    backoffMs: 200
```

### Run the Service

```bash
# Development mode