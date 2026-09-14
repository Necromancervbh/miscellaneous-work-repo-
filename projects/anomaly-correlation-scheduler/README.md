# Anomaly Correlation Forecast Scheduler  

**Category:** Data Science  
**Stack:** TypeScript / Node.js  

A lightweight, extensible scheduler that coordinates anomaly‑correlation forecasts, enforces API rate limits, and handles authentication automatically. Ideal for teams that need to run large batches of time‑sensitive predictive jobs without manual intervention.

---  

## Overview  

The **Anomaly Correlation Forecast Scheduler** (ACFS) abstracts three recurring concerns in data‑science pipelines:  

1. **Timing** – Define when each forecast should run (cron‑style, fixed intervals, or ad‑hoc).  
2. **Rate limiting** – Prevent API throttling by respecting per‑endpoint quotas.  
3. **Authentication** – Refresh and inject credentials (OAuth2, API keys, JWT) for every request.  

ACFS runs as a Node.js service, exposing a simple TypeScript API that can be embedded in existing ETL workflows or launched as a standalone daemon.

### Key Features  

| Feature | Benefit |
|---------|----------|
| **Declarative schedule definitions** | Write schedules in JSON/YAML; no cron‑syntax headaches. |
| **Pluggable rate‑limit strategies** | Token‑bucket, leaky‑bucket, or custom logic per endpoint. |
| **Auth adapters** | Built‑in OAuth2 client credentials, API‑key rotation, or custom token providers. |
| **Graceful shutdown & retry** | Guarantees at‑least‑once execution with exponential back‑off. |
| **Observability hooks** | Emits events for Prometheus, Grafana, or custom logging pipelines. |

---  

## Theory / Architecture  

```
+-------------------+        +-------------------+        +-------------------+
|   Scheduler Core  | <----> |   Rate‑Limiter    | <----> |   Auth Provider   |
+-------------------+        +-------------------+        +-------------------+
          ^                           ^                           ^
          |                           |                           |
          |   +-----------------------+---------------------------+
          |   |                       |                           |
          v   v                       v                           v
+-------------------+        +-------------------+        +-------------------+
|  Job Registry     |        |  Endpoint Proxy   |        |  Credential Store |
+-------------------+        +-------------------+        +-------------------+

```

### 1. Scheduler Core  

* **Job Registry** – Holds `ForecastJob` objects (id, payload, schedule, endpoint).  
* **Timing Engine** – Uses `node-cron`‑compatible expressions or absolute timestamps.  
* **Executor** – Pulls ready jobs, resolves auth, passes through the rate‑limiter, then dispatches the HTTP request.

### 2. Rate‑Limiter  

* Implemented as a **token‑bucket** per endpoint.  
* Configurable `capacity`, `refillRate`, and `burst` values.  
* Exposes `acquire(tokens: number): Promise<void>` that resolves when enough tokens are available.

### 3. Auth Provider  

* Abstract `AuthAdapter` interface: `getToken(): Promise<string>`.  
* Built‑in adapters:  
  * `OAuth2ClientCredentialsAdapter` – automatic token refresh.  
  * `ApiKeyAdapter` – rotates keys from a secure vault.  
* Custom adapters can be injected to support proprietary SSO flows.

### 4. Observability  

* Emits **events** (`job:start`, `job:success`, `job:fail`, `rate:throttled`).  
* Optional **metrics exporter** that registers counters/gauges with Prometheus client.

---  

## Quickstart  

### 1. Install  

```bash
npm i anomaly-correlation-forecast-scheduler
```

### 2. Create a scheduler instance  

```ts
import { Scheduler, CronSchedule, OAuth2ClientCredentialsAdapter, RateLimiter } from 'anomaly-correlation-forecast-scheduler';

// 1️⃣ Auth adapter – fetches a bearer token using client‑credentials flow
const auth = new OAuth2ClientCredentialsAdapter({
  tokenUrl: 'https://auth.example.com/oauth2/token',
  clientId: process.env.CLIENT_ID!,
  clientSecret: process.env.CLIENT_SECRET!,
  scopes: ['forecast:write'],
});

// 2️⃣ Rate limiter – 100 requests per minute with a burst of 20
const limiter = new RateLimiter({
  capacity: 100,
  refillRate: 100 / 60, // tokens per second
  burst: 20,
});

// 3️⃣ Scheduler – inject auth & limiter
const scheduler = new Scheduler({
  authAdapter: auth,
  rateLimiter: limiter,
});

// 4️⃣ Define a forecast job (run every hour at minute 15)
scheduler.registerJob({
  id: 'hourly-anomaly-forecast',
  endpoint: 'https://api.forecast.io/v1/anomaly',
  method: 'POST',
  payload: { region: 'us-west', horizon: '24h' },
  schedule: new CronSchedule('15 * * * *'), // 15 minutes past every hour
  retryPolicy: { maxAttempts: 5, back