# Anomaly Correlation Graph API  

**Category:** Full‑Stack  
**Stack:** Node.js • TypeScript • Express  

Secure, high‑performance API that exposes graph‑clustering and anomaly‑detection capabilities over relational or event‑driven data. Designed for micro‑service environments and easy integration with front‑end dashboards or data‑science pipelines.

---  

## Overview  

The **Anomaly Correlation Graph API** transforms raw entities and relationships into a weighted graph, runs clustering (e.g., Louvain, Leiden) to discover communities, and then evaluates each node/edge for anomalous behavior using statistical and machine‑learning models.  

Key features  

| Feature | Description |
|---------|-------------|
| **RESTful endpoints** for graph ingestion, clustering, and anomaly queries |
| **JWT‑based authentication** and role‑based access control |
| **Typed contracts** (OpenAPI + TypeScript) for compile‑time safety |
| **Pluggable storage** – in‑memory, Redis, or PostgreSQL (via TypeORM) |
| **Scalable** – horizontal scaling via stateless Express workers |
| **Observability** – built‑in metrics (Prometheus) and request tracing (OpenTelemetry) |

---  

## Theory & Architecture  

### 1. Data Model  

- **Node**: `{ id: string, attributes: Record<string, any> }`  
- **Edge**: `{ source: string, target: string, weight: number, attributes?: Record<string, any> }`  

All entities are stored as adjacency lists in a **GraphStore** abstraction that can be swapped at runtime.

### 2. Clustering Pipeline  

1. **Pre‑processing** – normalise edge weights, prune low‑weight edges (configurable threshold).  
2. **Community detection** – default implementation uses the **Louvain** algorithm (modularity optimisation). The pipeline is abstracted behind `IClusteringStrategy`, allowing alternative algorithms (Leiden, Spectral).  
3. **Post‑processing** – assign a **clusterId** to each node and persist the mapping.

### 3. Anomaly Scoring  

For each node/edge we compute a composite score:  

\[
\text{Score} = \alpha \cdot \underbrace{z_{\text{degree}}}_{\text{degree deviation}} + \beta \cdot \underbrace{z_{\text{weight}}}_{\text{edge‑weight deviation}} + \gamma \cdot \underbrace{p_{\text{model}}}_{\text{ML‑based probability}}
\]

- **Degree deviation** – Z‑score of node degree within its cluster.  
- **Weight deviation** – Z‑score of incident edge weights.  
- **ML probability** – output of a lightweight isolation‑forest model trained on historical snapshots.  

Parameters `α, β, γ` are configurable per tenant.

### 4. Security & Observability  

- **Authentication** – JWT signed with RS256; middleware validates token and extracts roles.  
- **Authorization** – per‑endpoint ACL defined in `policy.ts`.  
- **Rate limiting** – token bucket per API key (express-rate-limit).  
- **Metrics** – request latency, error counters, and clustering duration exported at `/metrics`.  
- **Tracing** – OpenTelemetry spans propagated to downstream services.

### 5. Deployment Diagram  

```
┌─────────────────────┐
│   API Gateway (NGINX)│
└───────▲───────▲──────┘
        │       │
   ┌────┴─────┐ ┌───────┐
   │ Express  │ │ Auth  │
   │ Workers  │ │ Service│
   └────▲─────┘ └────▲───┘
        │            │
   ┌────┴─────┐  ┌───┴─────┐
   │ GraphStore│ │ Model   │
   │ (Redis/PG)│ │ Service │
   └───────────┘ └─────────┘
```

---  

## Quickstart  

### Prerequisites  

- Node.js **≥18.x**  
- Yarn or npm  
- (Optional) Docker for containerised run  

### 1. Clone & Install  

```bash
git clone https://github.com/your-org/anomaly-correlation-graph-api.git
cd anomaly-correlation-graph-api

# Using Yarn
yarn install

# Or npm
npm ci
```

### 2. Environment  

Create a `.env` file (copy from `.env.example`) and set the required variables:

```dotenv
PORT=3000
JWT_PUBLIC_KEY=./keys/public.pem
JWT_PRIVATE_KEY=./keys/private.pem
GRAPH_STORE=memory   # or "redis", "postgres"
REDIS_URL=redis://localhost:6379
POSTGRES_URL=postgres://user:pass@localhost:5432/graphdb
ANOMALY_ALPHA