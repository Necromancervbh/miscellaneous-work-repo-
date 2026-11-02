# Graph Explorer for Anomaly Correlations
**Category:** Data Science  
**Stack:** TypeScript / Node.js  

## Overview
The **Graph Explorer for Anomaly Correlations** is an interactive service that discovers and visualizes relationships between anomalies in large‑scale datasets. By converting raw anomaly events into a weighted graph and applying clustering algorithms, the tool surfaces hidden patterns, enabling analysts to:

- Identify groups of co‑occurring anomalies.
- Trace propagation paths across systems or time.
- Drill down into specific clusters for root‑cause analysis.

The service exposes a simple REST API and a WebSocket‑enabled UI, allowing real‑time exploration of evolving anomaly graphs.

---

## Theory / Architecture
### 1. Data Ingestion
- **Source adapters** (Kafka, HTTP, file streams) emit anomaly records (`id`, `timestamp`, `features`, `severity`).
- Records are normalized into a unified **Anomaly DTO** and persisted in a time‑partitioned store (e.g., PostgreSQL + TimescaleDB).

### 2. Graph Construction
1. **Node creation** – each anomaly becomes a graph node.
2. **Edge generation** – similarity metrics (cosine similarity on feature vectors, temporal proximity, shared tags) produce weighted edges.
3. **Pruning** – edges below a configurable threshold are discarded to keep the graph sparse.

### 3. Clustering Engine
- **Algorithm**: Hierarchical Agglomerative Clustering (HAC) on the weighted adjacency matrix, optionally switched to **Louvain community detection** for large graphs.
- **Incremental updates** – new anomalies trigger local re‑clustering without recomputing the entire graph.

### 4. Service Layer (Node.js / TypeScript)
```
src/
├─ api/            # Express routes & WebSocket handlers
├─ ingestion/      # Kafka / HTTP adapters
├─ graph/          # Node/edge models, similarity utils
├─ clustering/     # HAC & Louvain implementations
├─ storage/        # DB access layer
└─ ui/             # Minimal React front‑end (served statically)
```

### 5. Visualization
- Front‑end uses **D3.js** to render force‑directed graphs.
- Users can filter by time window, severity, or cluster size.
- Clicking a node opens a detail pane with raw anomaly payload.

---

## Quickstart
### Prerequisites
- Node.js ≥ 18
- Yarn or npm
- Docker (optional, for running PostgreSQL + Kafka)

### 1. Clone & Install
```bash
git clone https://github.com/yourorg/graph-explorer-anomaly.git
cd graph-explorer-anomaly
yarn install   # or npm ci
```

### 2. Start supporting services (PostgreSQL + Kafka) via Docker Compose
```bash
docker compose up -d
```

### 3. Run the development server
```bash
yarn dev   # watches TS files and restarts automatically
```

The API will be available at `http://localhost:3000/api` and the UI at `http://localhost:3000`.

### 4. Ingest a sample anomaly (using `curl`)
```bash
curl -X POST http://localhost:3000/api/anomalies \
  -H "Content-Type: application/json" \
  -d '{
        "id": "a1b2c3",
        "timestamp": "2026-11-02T12:34:56Z",
        "features": [0.12, 0.87, 0.33],
        "severity": "high",
        "tags": ["cpu", "region-us-east"]
      }'
```

### 5. Query clusters
```bash
curl http://localhost:3000/api/clusters?window=1h
```

### 6. Open the UI
Navigate to `http://localhost:3000` in a browser. You should see a live‑updating graph where the newly posted anomaly appears as a node, automatically attached to its most similar peers.

---

## Complexity Analysis
| Component                | Time Complexity                              | Space Complexity                               |
|--------------------------|----------------------------------------------|-----------------------------------------------|
| **Similarity Computation** (pairwise) | `O(n²·d)` where `n` = #anomalies, `d` = feature dimension (optimized with LSH to near‑linear) | `O(n²)` for full adjacency matrix (sparse representation reduces to `O(k·n)`) |
| **Edge Pruning**         | `O(E)` where `E` = number of generated edges | `O(E)` (edges stored only if weight ≥ threshold) |
| **Hierarchical Agglomerative Clustering** | `O(n²)` (worst‑case) – mitigated by early stopping & cluster size caps | `O(n)` for dendrogram pointers |
| **Louvain Community Detection** | Approximately `O(E·log n)` per iteration | `O(E)` |
| **Incremental Update**   | `O(m·log n)` where `m` = new anomalies in a batch (local re‑clustering) | `O(m + affected edges)` |
| **Visualization Rendering (D3 force layout)** | `O(V·I)` where `V` = visible nodes, `I` = simulation iterations (