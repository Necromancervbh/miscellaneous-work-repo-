# Anomaly Correlation Alerting Service
**Category:** Full‑Stack  
**Stack:** Node.js • TypeScript • Redis  
**Description:** Real‑time alerts for correlated anomalies via WebSocket and email.

---

## Overview
The **Anomaly Correlation Alerting Service** ingests streams of anomaly events, groups them by correlation rules, and pushes notifications to interested clients instantly over WebSocket. When a correlation threshold is crossed, an email summary is also dispatched. The service is designed for low‑latency, high‑throughput environments such as monitoring platforms, IoT fleets, and financial fraud detection pipelines.

Key features:

- **Event ingestion** via HTTP POST (JSON) or direct Redis Pub/Sub.
- **Correlation engine** that evaluates user‑defined rules (time window, spatial proximity, severity weighting, etc.).
- **Real‑time delivery** through a WebSocket hub; clients receive only the alerts they subscribed to.
- **Email fallback** using a configurable SMTP provider for critical alerts.
- **Stateless API layer** backed by Redis for fast state sharing across multiple instances.

---

## Theory / Architecture

```
+-------------------+        +-------------------+        +-------------------+
|   Anomaly Source  |  -->   |  HTTP / Redis API |  -->   |  Correlation Core |
+-------------------+        +-------------------+        +-------------------+
                                   |                           |
                                   v                           v
                         +-------------------+        +-------------------+
                         |   Redis (Streams) |  <-->  |   Rule Engine     |
                         +-------------------+        +-------------------+
                                   |                           |
                                   v                           v
                         +-------------------+        +-------------------+
                         |   WebSocket Hub   |  -->   |   Email Dispatcher|
                         +-------------------+        +-------------------+
```

### Components

| Component | Responsibility | Tech |
|-----------|----------------|------|
| **API Gateway** | Accepts anomaly payloads (`POST /events`) and publishes them to a Redis stream (`anomaly:raw`). | Express + TypeScript |
| **Redis** | Acts as the durable message bus (streams) and stores temporary correlation state (hashes, sorted sets). | Redis 7.x |
| **Correlation Core** | Consumes raw events, applies user‑defined correlation rules, and emits **alert** objects when thresholds are met. | Worker process (Node.js) |
| **WebSocket Hub** | Maintains client connections, filters alerts per subscription, and pushes them instantly. | `ws` library |
| **Email Dispatcher** | Formats alert summaries and sends them via SMTP (or SES). | Nodemailer |
| **Rule Store** | Persists correlation rule definitions; hot‑reloaded without restart. | Redis hash `rules:<id>` |

### Data Flow

1. **Ingestion** – An external system POSTs an anomaly JSON payload. The API validates the schema and writes the event to `anomaly:raw` stream.
2. **Processing** – A worker reads from the stream, enriches the event (e.g., adds timestamps, computes severity scores), and checks it against all active rules.
3. **Correlation** – If a rule’s conditions (time window, count, combined severity, etc.) are satisfied, an **alert** object is created and written to `anomaly:alert` stream.
4. **Distribution** –  
   * **WebSocket** subscribers receive the alert instantly.  
   * **Email** service consumes the same alert stream; for alerts marked `critical`, it composes an email and sends it.
5. **Acknowledgement** – Clients can ACK alerts via WebSocket; the service updates a Redis sorted set to avoid duplicate deliveries.

---

## Quickstart

### Prerequisites
- Node.js ≥ 18
- Redis ≥ 7
- An SMTP server (or use a test service like Mailtrap)

### Installation

```bash
# Clone the repo
git clone https://github.com/yourorg/anomaly-correlation-alerting.git
cd anomaly-correlation-alerting

# Install dependencies
npm ci

# Build TypeScript sources
npm run build
```

### Configuration
Create a `.env` file at the project root:

```dotenv
# Server
PORT=8080

# Redis
REDIS_URL=redis://localhost:6379

# SMTP (example using Mailtrap)
SMTP_HOST=smtp.mailtrap.io
SMTP_PORT=2525
SMTP_USER=your_user
SMTP_PASS=your_pass
SMTP_FROM=alerts@example.com
```

### Run the service

```bash
npm start
```

The HTTP API will be available at `http://localhost:8080`, and the WebSocket endpoint at `ws://localhost:8080/ws`.

### Sending a test anomaly

```bash
curl -X POST http