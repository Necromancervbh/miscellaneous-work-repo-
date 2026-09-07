# Anomaly Management Platform  

**Category:** Data Science  
**Stack:** Node.js / TypeScript  

Unified API orchestrating detection, explainability, and real‑time alerts.

---  

## Overview  

The Anomaly Management Platform (AMP) provides a single, expressive REST/GraphQL API that abstracts the entire lifecycle of anomaly handling:

| Phase | What AMP does |
|------|----------------|
| **Detection** | Routes data to pluggable detection models (statistical, ML, rule‑based) and returns scored anomalies. |
| **Explainability** | Generates model‑agnostic explanations (SHAP, LIME, counter‑factuals) to help data scientists and business users understand *why* an event is flagged. |
| **Alerting** | Streams high‑confidence anomalies to configurable channels (WebSocket, Kafka, email, Slack) with throttling and escalation rules. |
| **Management** | Central metadata store for models, thresholds, and alert policies; versioned deployments via CI/CD. |

AMP is built as a **micro‑service** that can be deployed on‑prem or in the cloud, and it is fully typed with TypeScript to guarantee contract safety across teams.

---  

## Theory / Architecture  

### 1. High‑level diagram  

```
+-------------------+       +-------------------+       +-------------------+
|   Data Ingestor   | --->  |   Detection Hub   | --->  |   Explainability  |
| (REST / WS / Kafka) |     | (Model Registry) |     |   Service (SHAP) |
+-------------------+       +-------------------+       +-------------------+
                                   |                         |
                                   v                         v
                           +-------------------+   +-------------------+
                           |   Alert Engine    |   |   Persistence DB  |
                           | (Kafka / WS / SMTP) |   | (Postgres / Redis)|
                           +-------------------+   +-------------------+
```

### 2. Core components  

| Component | Responsibility | Key Types / Interfaces |
|-----------|----------------|------------------------|
| **API Gateway** | Validates requests, performs auth, forwards to services | `RequestContext`, `AuthToken` |
| **Detection Hub** | Loads model plugins, runs inference, returns `AnomalyScore` | `IModel`, `DetectionResult` |
| **Explainability Service** | Produces `Explanation` objects per anomaly | `IExplainer`, `FeatureContribution[]` |
| **Alert Engine** | Evaluates `AlertRule`s, de‑duplicates, pushes to sinks | `AlertPolicy`, `AlertPayload` |
| **Metadata Store** | Stores model versions, thresholds, user‑defined policies | `ModelMeta`, `PolicyMeta` |
| **Telemetry** | Emits Prometheus metrics & OpenTelemetry traces | `MetricRegistry`, `TraceSpan` |

### 3. Data flow  

1. **Ingestion** – Client posts a time‑series payload (`/detect`).  
2. **Routing** – Gateway selects the appropriate model based on `modelId` or auto‑selection logic.  
3. **Scoring** – Model returns a numeric score; the hub normalizes it to a probability.  
4. **Explainability** – If `explain=true`, the service runs SHAP/LIME and attaches `explanations` to the response.  
5. **Alerting** – Scores above the configured threshold trigger the Alert Engine, which respects rate‑limits and escalation paths.  
6. **Persistence** – All events are stored for audit and downstream analytics.

### 4. Extensibility  

- **Model plugins** implement the `IModel` interface and are discovered via a `plugins/` folder or npm package.  
- **Explainer plugins** implement `IExplainer`.  
- **Sink adapters** (Slack, PagerDuty, custom Webhooks) implement `IAlertSink`.  

---  

## Quickstart  

### Prerequisites  

- Node.js **≥ 18**  
- Yarn or npm  
- PostgreSQL (or Docker‑compose file provided)  

### 1. Clone & install  

```bash
git clone https://github.com/your-org/anomaly-management-platform.git
cd anomaly-management-platform
yarn install   # or npm ci
```

### 2. Set up environment  

Create a `.env` file (sample below):

```dotenv
# Server
PORT=8080
NODE_ENV=development

# Database
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=amp
POSTGRES_USER=amp_user
POSTGRES_PASSWORD=securepassword

# JWT secret for API auth
JWT_SECRET=supersecretkey
```

Run the DB container (optional):

```bash
docker compose up -d postgres
```

Run migrations:

```bash
yarn db:migrate
```

### 3. Start the platform  

```bash
yarn dev   # hot‑reload for development
# or
yarn start # production mode (compiled to ./dist)
```

The API is now reachable at `http://localhost:8080/api/v1`.

### 4. Code example – Detecting an anomaly  

```ts
import axios from 'axios';

interface DetectionRequest {
  modelId: string;
  timestamp: string;      // ISO‑8601
  values: Record<string, number>;
  explain?: boolean;
}

interface DetectionResponse