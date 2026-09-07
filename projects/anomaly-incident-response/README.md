# Anomaly Incident Response Orchestrator
**Category:** Data Science  
**Stack:** Node.js / TypeScript  

Automates ranking, enrichment, and notification of anomalies across services.

---

## Overview
The **Anomaly Incident Response Orchestrator** (AIR‑O) is a lightweight, extensible service that ingests anomaly signals from any number of monitoring pipelines, ranks them by severity, enriches them with contextual metadata, and dispatches actionable notifications to the appropriate responders.

Key benefits:

| ✅ Feature | 📄 Description |
|-----------|----------------|
| **Unified ranking** | Normalises disparate anomaly scores into a common severity metric. |
| **Dynamic enrichment** | Pulls service topology, recent deployments, and SLO health to add context. |
| **Pluggable notification** | Supports Slack, PagerDuty, email, or custom webhooks via a simple adapter interface. |
| **Stateless & scalable** | Runs as a stateless Node.js micro‑service; horizontal scaling is trivial. |
| **Typed contract** | Full TypeScript typings guarantee compile‑time safety for payloads and adapters. |

---

## Theory / Architecture
```
┌─────────────────────┐
│   Anomaly Sources   │   (Prometheus, Datadog, custom ML models, …)
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│   Ingestion Layer   │   REST / gRPC endpoint (JSON/Proto)
└───────┬─────┬───────┘
        │     │
        ▼     ▼
┌─────────────────────┐   ┌─────────────────────┐
│   Ranking Engine    │   │   Enrichment Engine │
│   - Normalisation   │   │   - Service graph   │
│   - Scoring model   │   │   - Deploy history  │
│   - Priority queue │   │   - SLO health      │
└───────┬─────┬───────┘   └───────┬─────┬───────┘
        │     │                 │     │
        ▼     ▼                 ▼     ▼
┌─────────────────────┐   ┌─────────────────────┐
│   Notification Hub  │◀──▶│   Adapter Registry │
│   - Dispatcher      │   │   (Slack, PagerDuty│
│   - Retry/Backoff   │   │    , Email, …)    │
└─────────────────────┘   └─────────────────────┘
```

### Core Concepts
1. **Signal Normalisation** – All incoming anomalies are mapped to a `NormalizedAnomaly` interface containing:
   - `sourceId`
   - `rawScore`
   - `timestamp`
2. **Severity Scoring** – A pluggable scoring function (`ScoreFn`) converts `rawScore` → `severity` (0‑100). Default implementation uses a logistic transform with configurable thresholds.
3. **Enrichment Pipeline** – Runs in parallel to the ranking step. Enrichers implement `Enricher<T>` and may query:
   - Service‑dependency graph (Neo4j, GraphQL)
   - CI/CD metadata (GitHub, ArgoCD)
   - Recent incidents (OpsGenie, ServiceNow)
4. **Notification Dispatch** – The hub selects the highest‑priority notification adapter based on severity thresholds defined in `notification-config.yaml`.

### Data Flow
1. **Receive** → HTTP POST `/api/v1/anomalies` (validated by `zod` schema).  
2. **Validate & Normalise** → `AnomalyNormalizer`.  
3. **Score** → `SeverityEngine` pushes to a priority queue (`heap-js`).  
4. **Enrich** → `EnrichmentOrchestrator` runs async enrichers, merges results.  
5. **Dispatch** → `Notifier` selects adapters, sends payload, logs outcome.

---

## Quickstart

### Prerequisites
- Node.js **≥ 18.x**
- Yarn or npm
- Access to a Slack workspace (or any other notification channel you intend to use)

### Installation
```bash
# Clone the repository
git clone https://github.com/your-org/anomaly-incident-response-orchestrator.git
cd anomaly-incident-response-orchestrator

# Install dependencies
yarn install   # or npm ci

# Build TypeScript sources
yarn build
```

### Configuration
Create a `config/local.yaml` (copy from `config/example.yaml`) and fill in the required keys:

```yaml
server:
  port: 3000

notification:
  slack:
    webhookUrl: "https://hooks.slack.com/services/XXXXX/XXXXX/XXXXX"
  pagerDuty:
    apiKey: "YOUR_PAGERDUTY_API_KEY"
```

### Run locally
```bash
# Start the service
yarn start
# or, with nodemon for hot‑reload
yarn dev
```

The API is now reachable at `http://localhost:3000/api/v1/anomalies`.

### Sending a test anomaly
```bash
curl -X POST http://localhost:3000/api/v1/anomalies \
  -H "Content-Type: application/json" \
  -d '{