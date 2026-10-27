# Anomaly Correlation Knowledge Base
**Category:** Data Science  
**Stack:** Node.js • TypeScript • GraphQL  

Unified API for querying anomalies, explanations, and visualizations across services.

---  

## Overview
The **Anomaly Correlation Knowledge Base (ACKB)** provides a single, GraphQL‑driven endpoint that aggregates anomaly data from multiple micro‑services, enriches it with contextual explanations, and serves ready‑to‑render visualizations.  

Key goals:

- **Consistency:** One schema to fetch anomalies regardless of their origin.  
- **Explainability:** Attach root‑cause narratives and statistical metrics.  
- **Visualization‑Ready:** Return chart configurations (e.g., Plotly, Vega) alongside raw data.  
- **Extensibility:** Plug‑in new data sources without breaking existing queries.

---  

## Theory & Architecture  

### 1. Data Ingestion Layer
- **Connectors** (Node.js adapters) pull time‑series anomaly events from downstream services (e.g., monitoring, fraud detection, IoT).  
- Each connector normalizes payloads to a **canonical anomaly model**:
  ```ts
  interface Anomaly {
    id: string;
    timestamp: string;          // ISO 8601
    metric: string;
    severity: number;           // 0‑1
    sourceService: string;
    rawPayload: Record<string, any>;
  }
  ```

### 2. Knowledge Graph Store
- Normalized anomalies are stored in **Neo4j** (or any property graph DB).  
- Nodes: `Anomaly`, `Metric`, `Service`, `Explanation`.  
- Relationships capture:
  - `DETECTED_IN` (Anomaly → Service)  
  - `MEASURES` (Anomaly → Metric)  
  - `EXPLAINS` (Explanation → Anomaly)  

### 3. Explanation Engine
- Runs statistical post‑processing (e.g., SHAP, causal inference) to generate human‑readable explanations.  
- Results are persisted as `Explanation` nodes linked to the originating anomaly.

### 4. Visualization Service
- A lightweight micro‑service builds **chart specifications** (Plotly JSON) on‑the‑fly using the stored time‑series context.  
- The spec is attached to the GraphQL response under `visualization`.

### 5. GraphQL API Gateway
- **Apollo Server** (Node.js + TypeScript) stitches resolvers for:
  - `anomalies(filter: AnomalyFilter): [Anomaly!]!`
  - `explanations(anomalyId: ID!): Explanation`
  - `visualization(anomalyId: ID!): VisualizationSpec`
- The schema is versioned via **Apollo Federation**, allowing other teams to extend it.

```
type Query {
  anomalies(filter: AnomalyFilter): [Anomaly!]!
  anomaly(id: ID!): Anomaly
}

type Anomaly {
  id: ID!
  timestamp: String!
  metric: String!
  severity: Float!
  sourceService: String!
  explanation: Explanation
  visualization: VisualizationSpec
}

type Explanation {
  summary: String!
  details: String
  confidence: Float!
}

type VisualizationSpec {
  type: String!      # e.g., "plotly"
  spec: JSON!        # raw Plotly/Vega spec
}
```

---  

## Quickstart  

### Prerequisites
- Node.js >= 18  
- Yarn or npm  
- Docker (for Neo4j & optional services)  

### 1. Clone & Install
```bash
git clone https://github.com/yourorg/ackb.git
cd ackb
yarn install   # or npm ci
```

### 2. Spin up dependencies (Neo4j + mock data source)
```bash
docker compose up -d neo4j mock-service
```

### 3. Run the API server
```bash
yarn dev   # starts Apollo Server on http://localhost:4000
```

### 4. Sample GraphQL query (TypeScript client)

```ts
import { ApolloClient, InMemoryCache, gql } from '@apollo/client';
import fetch from 'cross-fetch';

const client = new ApolloClient({
  uri: 'http://localhost:4000/graphql',
  cache: new InMemoryCache(),
  fetch,
});

const GET_ANOMALY_DETAILS = gql`
  query GetAnomaly($id: ID!) {
    anomaly(id: $id) {
      id
      timestamp
      metric
      severity
      sourceService
      explanation {
        summary
        confidence
      }
      visualization {
        type
        spec
      }
    }
  }
`;

async function fetchAnomaly(id: string) {
  const { data } = await client.query({
    query: GET_ANOMALY_DETAILS,
    variables: { id },
  });
  console.log(JSON.stringify(data, null, 2));
}

// Example usage
fetchAnomaly('anomaly-1234');
```

Running the script prints the anomaly together with its explanation and a Plotly spec ready to be rendered in a web UI.

---  

## Complexity Analysis  

| Component                     | Time Complexity                              | Space Complexity                               |
|-------------------------------|----------------------------------------------|-----------------------------------------------|
| **Ingestion (per event)**     | `O(1)` – constant‑time normalization + DB write