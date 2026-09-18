# Anomaly Correlation API Gateway
**Category:** Data Science  
**Stack:** Node.js / TypeScript  

Unified REST gateway that aggregates, validates, and forwards requests to the dashboard, orchestrator, and explainability services. It provides a single entry‑point for clients, handles authentication, request throttling, and response normalization.

---  

## Overview
The **Anomaly Correlation API Gateway** sits in front of three core micro‑services:

| Service | Responsibility |
|---------|-----------------|
| **Dashboard** | Visualisation & UI data retrieval |
| **Orchestrator** | Scheduling, job orchestration, and anomaly detection pipelines |
| **Explainability** | Model interpretability & feature‑level explanations |

Instead of each client having to know the individual URLs, auth tokens, and payload contracts, they call the gateway’s clean REST endpoints. The gateway:

* Validates request schemas (using **AJV**)
* Performs JWT‑based authentication & role‑based access control
* Rate‑limits per‑client using **express-rate-limit**
* Routes to the appropriate downstream service via HTTP/HTTPS
* Normalizes responses into a consistent envelope (`{status, data, meta}`)

The project is written in **TypeScript** for type safety and is built on **Express** with **Node.js 20+**.

---  

## Theory / Architecture  

```
+-------------------+          +-------------------+          +-------------------+
|   Client (Web /   |  HTTPS   |   API Gateway     |  HTTP    |   Dashboard Svc   |
|   Mobile / CLI)  |--------->|  (Node.js/TS)     |--------->|   (REST)          |
+-------------------+          +-------------------+          +-------------------+
                                   |
                                   |  HTTP
                                   v
                          +-------------------+
                          | Orchestrator Svc  |
                          +-------------------+
                                   |
                                   |  HTTP
                                   v
                          +-------------------+
                          | Explainability Svc|
                          +-------------------+
```

### Key Components  

| Component | Description |
|-----------|-------------|
| **Router Layer** | Express routers (`/dashboard`, `/orchestrator`, `/explain`) map to downstream services. |
| **Validator Middleware** | JSON schema validation with AJV; rejects malformed payloads early (HTTP 400). |
| **Auth Middleware** | Verifies JWTs, extracts `sub` and `roles`, attaches `req.user`. |
| **Rate Limiter** | Global and per‑endpoint throttling to protect downstream services. |
| **Proxy Handler** | Uses `http-proxy-middleware` to forward the request, preserving method, headers, and body. |
| **Response Normalizer** | Wraps downstream payloads into `{ status, data, meta }` and strips internal fields. |
| **Health & Metrics** | `/healthz` for liveness, `/metrics` (Prometheus format) for observability. |

### Data Flow  

1. **Incoming request** → Express → **Auth** → **Rate‑limit** → **Validate**.  
2. If all checks pass, the **Proxy Handler** rewrites the target URL (`process.env.DASHBOARD_URL`, etc.) and streams the request to the downstream service.  
3. The downstream service responds; the gateway intercepts the response, normalizes it, and returns to the client.  
4. Errors are caught by a global error handler and transformed into a standard error envelope.

---  

## Quickstart  

### Prerequisites  

| Tool | Minimum Version |
|------|-----------------|
| Node.js | 20.x |
| npm | 9.x |
| Docker (optional) | 20.x |

### Installation  

```bash
# Clone the repo
git clone https://github.com/yourorg/anomaly-correlation-gateway.git
cd anomaly-correlation-gateway

# Install dependencies
npm ci

# Build TypeScript sources
npm run build
```

### Configuration  

Create a `.env` file at the project root (example below). Use a secret manager in production.

```dotenv
# Server
PORT=8080

# Downstream service URLs
DASHBOARD_URL=https://dashboard.internal/api
ORCHESTRATOR_URL=https://orchestrator.internal/api
EXPLAINABILITY_URL=https://explainability.internal/api

# JWT settings
JWT_PUBLIC_KEY=-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqh...
JWT_ISSUER=https://auth.yourcompany.com/
JWT_AUDIENCE=anomaly-gateway

# Rate limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=120
```

### Run locally  

```bash
npm start
```

The gateway will be reachable at `http://localhost:8080`.

### Example: Call the Explainability endpoint  

```typescript
import axios from 'axios';
import jwt from 'jsonwebtoken';

// Generate a test JWT (replace with real token in prod)
const token = jwt.sign(
  { sub: 'user123', roles: