# Anomaly Correlation Graph Analysis  
**Category:** Data Science  
**Stack:** TypeScript / Node.js  

Detect and visualize anomaly clusters using graph traversal and community detection.

---  

## Overview  

Anomaly Correlation Graph Analysis (ACGA) is a lightweight Node.js library that transforms raw anomaly scores into a **correlation graph**, then extracts meaningful clusters through community‑detection algorithms.  
Key capabilities:

- **Ingest** time‑series or event‑based anomaly scores.  
- **Build** a weighted graph where nodes represent data points and edges encode similarity (e.g., Pearson, cosine).  
- **Traverse** the graph to prune weak connections and isolate dense sub‑graphs.  
- **Detect** communities using the Louvain or Leiden algorithms.  
- **Export** results as JSON and render interactive visualizations with D3.js or Vis.js.  

Designed for data‑science pipelines, ACGA can be dropped into ETL jobs, real‑time monitoring services, or Jupyter‑like notebooks powered by `ts-node`.

---  

## Theory & Architecture  

### 1. Data Ingestion  

```ts
interface AnomalyRecord {
  id: string;               // unique identifier (timestamp, sensor ID, etc.)
  features: number[];       // numeric vector representing the observation
  score: number;            // anomaly score (higher = more anomalous)
}
```

- Records are streamed or batch‑loaded from CSV, JSON, Kafka, etc.  
- Optional **pre‑filter** removes records below a configurable score threshold.

### 2. Correlation Graph Construction  

1. **Similarity Computation** – For each pair *(i, j)* compute a similarity metric *s(i,j)* (default: cosine similarity).  
2. **Edge Weighting** – Edge weight = *s(i,j) × (score_i + score_j) / 2*.  
3. **Sparsification** – Keep only the top‑k neighbors per node or edges with weight ≥ *ε*.  

Result: an undirected weighted graph `G(V, E)` where `V` = anomaly records.

### 3. Graph Traversal & Pruning  

- **Breadth‑First Search (BFS)** from high‑score seed nodes to collect reachable sub‑graphs.  
- **Edge‑cut pruning** removes bridges whose weight falls below a dynamic threshold, preventing noisy connections from merging distinct clusters.

### 4. Community Detection  

Implemented wrappers around two popular algorithms:

| Algorithm | Library | Complexity | When to use |
|-----------|---------|------------|-------------|
| Louvain   | `graphology-communities-louvain` | ~O(|E|) | Fast, good for large sparse graphs |
| Leiden    | `graphology-communities-leiden` | ~O(|E|·log|V|) | More accurate, handles resolution parameter |

Both return a mapping `nodeId → communityId`.

### 5. Output & Visualization  

- **JSON Export** – `{ communityId: string, members: string[], centroid: number[] }`  
- **Interactive UI** – `visualize.ts` spins up an Express server serving a D3.js page that renders nodes colored by community, with zoom/pan controls.

### 6. Project Structure  

```
src/
 ├─ data/                # parsers & adapters (CSV, Kafka, etc.)
 ├─ graph/
 │   ├─ builder.ts       # similarity & edge creation
 │   ├─ traversal.ts     # BFS, pruning utilities
 │   └─ community.ts     # Louvain / Leiden wrappers
 ├─ visual/
 │   └─ server.ts        # Express + D3 front‑end
 └─ index.ts             # public API
tests/
 └─ *.spec.ts           # Jest unit & integration tests
scripts/
 └─ benchmark.ts        # performance profiling
```

---  

## Quickstart  

### Prerequisites  

```bash
# Node.js >= 18
npm install -g pnpm   # or npm/yarn
```

### Installation  

```bash
pnpm add anomaly-correlation-graph
```

### Basic Usage  

```ts
// example.ts
import { loadCsv, buildGraph, detectCommunities, exportResults } from 'anomaly-correlation-graph';

// 1️⃣ Load anomaly records (CSV with columns: id,score,feat1,feat2,...)
const records = await loadCsv('./data/anomalies.csv');

// 2️⃣ Build the correlation graph (keep top 5 neighbors per node)
const graph = buildGraph(records, {
  similarity: 'cosine',
  topK: 5,
  minScore: 0.7,
});

// 3️⃣ Prune weak edges (weight threshold = 0.4)
graph.pruneEdges(0.4);

// 4️⃣ Detect communities using the Leiden algorithm
const communities = detectCommunities(graph, {
  method: 'leiden',
  resolution: 1.2,
});

// 5️⃣ Export results for downstream analysis
await exportResults(communities, './output/communities.json');

// 6️⃣ (Optional) Spin up a visual UI
import { startServer } from 'anomaly-correlation-graph/visual';
startServer