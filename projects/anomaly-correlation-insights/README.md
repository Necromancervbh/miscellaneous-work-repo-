# Anomaly Correlation Insights Dashboard

**Category:** Full‑Stack  
**Stack:** TypeScript • React • Node.js • D3  

An interactive web application for visualizing, querying, and explaining correlations between anomalies detected in time‑series data. The dashboard combines a modern React front‑end with D3‑driven visualizations and a Node.js back‑end that serves data, runs correlation analytics, and provides natural‑language explanations.

---

## Overview

The **Anomaly Correlation Insights Dashboard** empowers data scientists, analysts, and engineers to:

- **Explore** anomaly events across multiple metrics on a shared timeline.  
- **Query** relationships (e.g., “show all temperature spikes that co‑occur with pressure drops”).  
- **Explain** detected correlations with automatically generated textual insights.  
- **Interact** with rich D3 visualizations (heat‑maps, parallel coordinates, network graphs) that update in real time as filters change.

Key features:

| Feature | Description |
|---------|-------------|
| **Dynamic querying** | GraphQL‑like endpoint for ad‑hoc filters, time windows, and metric selections. |
| **Correlation engine** | Fast Pearson, Spearman, and Mutual‑Information calculations on streaming windows. |
| **Explainability layer** | Template‑driven natural‑language generation powered by statistical significance scores. |
| **Responsive UI** | React + TypeScript components with D3 for high‑performance SVG/Canvas rendering. |
| **Extensible back‑end** | Plug‑in architecture for custom metrics, data sources, and explanation strategies. |

---

## Theory / Architecture

### 1. Data Flow

```
[Data Sources] → (Ingestion Service) → [Time‑Series DB] → (Correlation Service) → [API Server] ↔ [React Front‑End]
```

- **Ingestion Service** (Node.js) normalizes raw logs, sensor feeds, or CSV uploads into a time‑series store (e.g., InfluxDB or TimescaleDB).  
- **Correlation Service** runs on a worker pool, sliding a configurable window (default 1 h) across the series and computes pairwise statistics. Results are cached in Redis for sub‑second retrieval.  
- **API Server** (Express + TypeScript) exposes REST endpoints:
  - `GET /anomalies` – list anomalies with metadata.  
  - `POST /query` – accept a query payload, return matching anomalies + correlation scores.  
  - `GET /explain/:pairId` – return a human‑readable explanation.  

### 2. Front‑End Architecture

- **State Management** – Redux Toolkit with RTK Query for data fetching; selectors keep UI in sync with query results.  
- **Visualization Layer** – D3 is wrapped in reusable React hooks (`useD3Chart`) to keep the declarative React model while leveraging D3’s imperative API for complex SVG manipulations.  
- **Component Hierarchy**  

```
<App>
 ├─ <Header>
 ├─ <SidebarFilters>
 ├─ <MainCanvas>
 │    ├─ <HeatMap />
 │    ├─ <ParallelCoordinates />
 │    └─ <NetworkGraph />
 └─ <ExplanationPanel />
```

### 3. Explainability Engine

1. **Statistical Significance** – Compute p‑values for each correlation metric.  
2. **Template Selection** – Choose a natural‑language template based on significance level and direction (positive/negative).  
3. **Slot Filling** – Insert metric names, time windows, and numeric values.  
4. **Post‑Processing** – Minor grammar fixes using a lightweight rule‑based system.

---

## Quickstart

### Prerequisites

- Node.js **≥ 18**  
- Yarn (or npm)  
- Docker (optional, for running the time‑series DB)

### 1. Clone & Install

```bash
git clone https://github.com/yourorg/anomaly-correlation-dashboard.git
cd anomaly-correlation-dashboard
yarn install          # or npm ci
```

### 2. Run the Development Stack

```bash
# Start the database (TimescaleDB) via Docker
docker compose up -d db

# Seed sample data (optional)
yarn seed:data

# Launch back‑end API (Node.js)
yarn dev:api          # runs on http://localhost:4000

# Launch front‑end (React + Vite)
yarn dev:ui           # runs on http://localhost:3000
```

The UI will automatically connect to the API at `http://localhost:4000`. Open `http://localhost:3000` in your browser to explore the dashboard.

### 3. Example Query (cURL)

```bash
curl -X POST http://localhost:4000/query \
  -H "Content-Type: application/json" \
  -d '{
        "metrics": ["temperature", "pressure"],
        "timeRange": {"from": "2024-01-01T00:00:00Z", "to": "2024-01-07T23:59:59Z"},
        "anomalyThreshold": 3,
        "correlationMethod": "pearson"
      }'
```

Response (truncated):

```json
{
  "results": [
    {
      "metricA": "temperature",
      "