# Anomaly Correlation Hub

**Category:** Full‑Stack  
**Stack:** Node.js • TypeScript • Redis  

Unified API gateway that centralises authentication, rate‑limiting, and real‑time anomaly alerts for micro‑service ecosystems.

---

## Overview

The **Anomaly Correlation Hub (ACH)** acts as a single entry point for all downstream services. It provides:

- **Authentication & Authorization** – JWT validation + role‑based access control.
- **Rate Limiting** – Distributed token‑bucket algorithm powered by Redis.
- **Real‑time Alerts** – Pub/Sub‑driven anomaly detection notifications pushed via Server‑Sent Events (SSE) or WebSockets.
- **Extensible Middleware** – Plug‑in architecture for custom validation, logging, or transformation layers.

By consolidating these cross‑cutting concerns, teams can focus on domain logic while ACH guarantees security, stability, and observability across the entire stack.

---

## Theory / Architecture

```
+-------------------+        +-------------------+        +-------------------+
|   Client (Web /   |  HTTP  |   API Gateway     |  Redis |   Alert Service   |
|   Mobile / CLI)  |<------>|   (Node.js TS)    |<------>|   (Pub/Sub)       |
+-------------------+        +-------------------+        +-------------------+
                                 |   ^   |
                                 |   |   |
                +----------------+   |   +----------------+
                |                    |                    |
        +-------v------+      +------v------+      +------v------+
        | Auth Service |      | Rate Limiter|      | Event Bus   |
        +--------------+      +-------------+      +-------------+
```

### Core Components

| Component | Responsibility | Key Technologies |
|-----------|----------------|------------------|
| **API Gateway** | Routes requests, applies middleware chain | Express.js, `express-promise-router` |
| **Auth Service** | Verifies JWTs, fetches user roles from Redis | `jsonwebtoken`, Redis `HASH` |
| **Rate Limiter** | Distributed token‑bucket per API key/IP | Redis `INCR`, Lua script for atomicity |
| **Alert Engine** | Publishes anomaly events, subscribes for real‑time push | Redis Pub/Sub, SSE / WebSocket server |
| **Cache Layer** | Stores session data, rate‑limit counters | Redis `SETEX`, `TTL` |
| **Metrics & Logging** | Exposes Prometheus metrics, structured logs | `prom-client`, `pino` |

### Request Flow (simplified)

1. **Ingress** – Client sends HTTP request with `Authorization: Bearer <jwt>`.
2. **Auth Middleware** – JWT is decoded; user ID & roles are cached in Redis for fast lookup.
3. **Rate‑Limit Middleware** – Lua script atomically checks/updates the token bucket. If exhausted, a `429 Too Many Requests` is returned.
4. **Routing** – Request is proxied to the appropriate downstream micro‑service.
5. **Anomaly Detection** – Downstream service publishes an anomaly event to Redis `channel:anomalies`.
6. **Alert Service** – Subscribes to the channel, formats the payload, and pushes it to connected clients via SSE/WebSocket.
7. **Response** – Downstream response is returned to the client unchanged.

### Data Structures in Redis

- `auth:user:{userId}` → HASH (`role`, `lastLogin`, …) – TTL 24 h.
- `rl:{apiKey}:{endpoint}` → STRING (remaining tokens) – TTL = bucket refill interval.
- `pubsub:anomalies` → CHANNEL for real‑time alerts.

---

## Quickstart

### Prerequisites

| Tool | Minimum Version |
|------|-----------------|
| Node.js | 18.x |
| npm / yarn | 8.x |
| Docker (optional) | 20.x |
| Redis | 6.2+ (or Docker image `redis:7`) |

### Installation

```bash
# Clone the repo
git clone https://github.com/yourorg/anomaly-correlation-hub.git
cd anomaly-correlation-hub

# Install dependencies
npm ci   # or `yarn install`

# Build TypeScript sources
npm run build
```

### Running