# Anomaly Correlation Visualization

**Category:** Data Science  
**Stack:** TypeScript • D3.js  

Interactive visual analytics for exploring and interpreting anomaly correlation patterns in multidimensional datasets.

---

## Overview

The **Anomaly Correlation Visualization** project provides a web‑based, highly responsive interface for analysts to:

- Load time‑series or spatial datasets containing flagged anomalies.
- Compute pairwise correlation metrics (Pearson, Spearman, or custom similarity scores) between anomaly events.
- Render dynamic, zoomable heatmaps, network graphs, and timeline overlays powered by **D3.js**.
- Drill‑down into individual anomalies to view raw data, statistical summaries, and related metadata.

Designed for data scientists, domain experts, and developers who need an intuitive way to surface hidden relationships among anomalies without writing custom visualisation code.

---

## Theory / Architecture

### 1. Data Model

| Entity | Description |
|--------|-------------|
| **Anomaly** | `{ id: string, timestamp: number, dimensions: Record<string, number>, metadata?: any }` |
| **Correlation Matrix** | Square matrix `C[i][j]` where each entry is a similarity score between anomaly *i* and *j*. |
| **Graph** | Nodes represent anomalies; edges exist when `C[i][j]` exceeds a configurable threshold. |

### 2. Core Pipeline

1. **Ingestion** – CSV/JSON loader parses raw anomaly logs into the internal `Anomaly[]` structure.
2. **Feature Extraction** – Selected dimensions are normalized (z‑score) and optionally reduced via PCA for high‑dimensional data.
3. **Correlation Computation** –  
   - **Pearson** for linear relationships.  
   - **Spearman** for monotonic trends.  
   - **Custom** similarity functions (e.g., cosine, DTW) can be plugged via the `Similarity` interface.  
   The computation runs in **O(N²·D)** where *N* is the number of anomalies and *D* the number of selected dimensions.
4. **Thresholding & Graph Construction** – Edges are created when `score ≥ τ`. The resulting adjacency list feeds the D3 force‑layout.
5. **Rendering** – D3.js draws:
   - **Heatmap** of the correlation matrix (SVG + Canvas hybrid for large *N*).  
   - **Force‑directed graph** for network view.  
   - **Timeline** brush for temporal filtering.

### 3. Component Diagram

```
+-------------------+      +-------------------+      +-------------------+
|   Data Loader     | ---> |  Correlation Core | ---> |   D3 Visualizer   |
+-------------------+      +-------------------+      +-------------------+
        |                         |                         |
   CSV/JSON                 Similarity API               SVG/Canvas
```

- **Modularity** – Each stage is a separate TypeScript module with well‑defined interfaces, enabling easy replacement (e.g., swap PCA for t‑SNE).
- **Performance** – Heavy numeric work is delegated to Web Workers, keeping the UI thread responsive.

---

## Quickstart

### Prerequisites

- Node.js ≥ 18
- npm or yarn
- Modern browser with ES6 support

### Installation

```bash
# Clone the repository
git clone https://github.com/yourorg/anomaly-correlation-visualization.git
cd anomaly-correlation-visualization

# Install dependencies
npm install   # or `yarn install`

# Build the project
npm run build
```

### Running the Demo

```bash
npm run serve   # Starts a local dev server at http://localhost:3000
```

Open the URL in your browser and use the **Upload** button to load a CSV file with the following columns:

| Column      | Example |
|-------------|---------|
| `id`        | `A123`  |
| `timestamp` | `1627849200` (Unix epoch) |
| `dim1` … `dimK` | numeric sensor readings |
| `metadata`  | optional JSON string |

### Minimal Code Example

Below is a minimal TypeScript snippet showing how to embed the visualizer in a custom page:

```ts
import { AnomalyViewer } from 'anomaly-correlation-visualization';
import type { Anomaly } from 'anomaly-correlation-visualization/types';

// 1. Prepare anomaly data
const anomalies: Anomaly[] = [
  { id: 'a1', timestamp: 1627849200, dimensions: { temp: 23.5, pressure: 101.2 } },
  { id: 'a2', timestamp: 1627852800, dimensions: { temp: 24.1, pressure: 100.9 } },
  // ... more records
];

// 2. Initialise the viewer
const container = document.getElementById('viz-root')!;
const viewer = new AnomalyViewer(container,