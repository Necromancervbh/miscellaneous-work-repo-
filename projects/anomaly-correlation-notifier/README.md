# Anomaly Correlation Notifier
**Category:** Data Science  
**Stack:** Node.js / TypeScript  

Real‑time alerts for correlated anomalies via WebSocket and email.

---

## Overview
The **Anomaly Correlation Notifier** is a lightweight service that ingests streams of anomaly events, detects statistically significant correlations, and pushes notifications to interested clients instantly.  

Key features:

- **Live streaming** via WebSocket – clients receive alerts the moment a correlation is detected.  
- **Email fallback** – critical alerts are also sent to configured recipients.  
- **Pluggable anomaly sources** – works with any system that can POST JSON events.  
- **Type‑safe** core written in TypeScript, ensuring maintainability and easy extension.  

---

## Theory & Architecture
### 1. Data Flow
```
[Anomaly Source] → HTTP POST → [Ingestion Service] → Correlation Engine → (WebSocket / Email) → [Clients]
```

1. **Ingestion Service**  
   - Validates incoming JSON payloads (`timestamp`, `metricId`, `value`, `severity`).  
   - Stores events in an in‑memory time‑window (configurable, default 5 min).  

2. **Correlation Engine**  
   - Maintains a sliding window per metric.  
   - Computes pairwise Pearson correlation `r` for all metric combinations within the window.  
   - Triggers an alert when `|r| ≥ 0.8` **and** both metrics have severity ≥ `WARN`.  

3. **Notifier**  
   - **WebSocket Server** broadcasts a JSON alert to all subscribed sockets.  
   - **Email Dispatcher** uses Nodemailer to send a templated message to the alert list.  

### 2. Core Modules
| Module | Responsibility |
|--------|----------------|
| `src/server.ts` | Express API + WebSocket upgrade |
| `src/ingest.ts` | Validation, buffering, window management |
| `src/correlation.ts` | Efficient O(n²) correlation calculation with incremental updates |
| `src/notifier.ts` | WebSocket broadcast & email delivery |
| `src/types.ts` | Shared TypeScript interfaces (`AnomalyEvent`, `Alert`) |

### 3. Design Decisions
- **In‑memory window**: Fast enough for sub‑second latency; can be swapped for Redis Streams for horizontal scaling.  
- **Pearson correlation**: Simple, interpretable metric; suitable for linear relationships common in sensor data.  
- **Event‑driven architecture**: Decouples ingestion from notification, enabling future extensions (e.g., Slack, PagerDuty).  

---

## Quickstart
### Prerequisites
- Node.js ≥ 18  
- Yarn or npm  

### Installation
```bash
# Clone the repo
git clone https://github.com/yourorg/anomaly-correlation-notifier.git
cd anomaly-correlation-notifier

# Install dependencies
yarn install   # or npm ci
```

### Configuration
Create a `.env` file at the project root:

```dotenv
PORT=8080
WS_PATH=/alerts
EMAIL_HOST=smtp.example.com
EMAIL_PORT=587
EMAIL_USER=alert-bot@example.com
EMAIL_PASS=supersecret
ALERT_RECIPIENTS=ops@example.com,dev@example.com
CORRELATION_THRESHOLD=0.8
WINDOW_MINUTES=5
```

### Run the service
```bash
yarn start   # or npm run start
```

The server will listen on `http://localhost:8080`.  
WebSocket endpoint: `ws://localhost:8080/alerts`  
POST anomalies to `http://localhost:8080/api/anomalies`.

### Example: Sending an anomaly & receiving an alert
```typescript
import axios from 'axios';
import WebSocket from 'ws';

// 1️⃣ Open a WebSocket client
const ws = new WebSocket('ws://localhost:8080/alerts');
ws.on('message', (data) => {
  console.log('🔔 Alert received:', data.toString());
});

// 2️⃣ Post two correlated anomalies
async function sendAnomalies() {
  const now = Date.now();
  await axios.post('http://localhost:8080/api/anomalies', {
    timestamp: now,
    metricId: 'cpu_usage',
    value: 92,
    severity: 'WARN',
  });

  await axios.post('http://localhost:8080/api/anomalies', {
    timestamp: now + 1000,
    metricId: 'memory_pressure',
    value: 88,
    severity: 'WARN',
  });
}

sendAnomalies();
```

If the correlation between `cpu_usage` and `memory_pressure` exceeds the configured threshold, you’ll see a JSON alert on the WebSocket console and an email dispatched to the recipients.

---

## Complexity Analysis
| Operation | Time Complexity | Space Complexity | Remarks |
|-----------|----------------|------------------|---------|
| **Ingestion (per event)** | `O(1)` (push to window) | `O(W·M