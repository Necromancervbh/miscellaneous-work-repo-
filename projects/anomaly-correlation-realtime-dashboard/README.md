# Real‑Time Anomaly Correlation Dashboard
**Category:** Full‑Stack  
**Stack:** Node.js • React • WebSocket  

Live UI visualizing anomaly scores and alerts as they stream from backend services.

---  

## Overview
The **Real‑Time Anomaly Correlation Dashboard** provides a responsive, single‑page interface that displays anomaly scores, correlated events, and alert notifications in real time.  
- **Live streaming:** Uses WebSocket to push anomaly data from the Node.js server to the React client instantly.  
- **Correlation view:** Groups related anomalies by source, time window, and severity, helping operators spot patterns.  
- **Alert handling:** Highlights critical alerts, supports acknowledgment, and logs user actions.  
- **Extensible:** Plug‑in architecture for custom data sources, scoring algorithms, and visual widgets.

---  

## Theory / Architecture
```
+-------------------+          WebSocket          +-------------------+
|   Data Sources    | <-------------------------> |   Node.js Server  |
| (sensors, logs,  |   (JSON messages)            |  (Express + WS)   |
|  ML models, …)   |                               +-------------------+
+-------------------+                                        |
          |                                                   |
          | 1. Ingest raw events                               |
          | 2. Compute anomaly score (plug‑in)                |
          | 3. Correlate with recent events (sliding window) |
          | 4. Emit enriched payload                          |
          v                                                   v
+-------------------+          HTTP/WS          +-------------------+
|   Persistence     | <-------------------------> |   React Frontend |
| (optional DB)     |   (REST for config)          |  (Vite + Redux) |
+-------------------+                               +-------------------+
```

### Key Components
| Component | Responsibility | Tech |
|-----------|----------------|------|
| **Ingestion Service** | Pulls raw telemetry, normalizes payloads | Node.js streams |
| **Scoring Engine** | Applies statistical/ML models to produce a numeric anomaly score | Custom plug‑in (Python, TensorFlow, etc.) |
| **Correlation Engine** | Maintains a time‑based graph of events, groups by similarity | Sliding‑window, hash maps |
| **WebSocket Hub** | Broadcasts enriched events to all connected clients | `ws` library |
| **API Layer** | CRUD for dashboards, user preferences, alert rules | Express + JWT |
| **React UI** | Real‑time charts, tables, and alert panels | Recharts, Material‑UI, Redux Toolkit |
| **Persistence (optional)** | Stores historic anomalies for trend analysis | PostgreSQL / MongoDB |

### Data Flow
1. **Raw event** arrives → Ingestion normalizes → **Scoring Engine** emits `{id, score, timestamp, metadata}`.  
2. **Correlation Engine** updates internal state, produces a **correlation ID** and a list of related events.  
3. Enriched message is sent via **WebSocket** to every client.  
4. Client updates charts/tables instantly; critical alerts trigger visual cues and optional sound.

---  

## Quickstart
> **Prerequisites**  
> - Node.js ≥ 18  
> - npm ≥ 9  
> - (Optional) Docker if you prefer containerised DB

### 1. Clone the repo
```bash
git clone https://github.com/yourorg/real-time-anomaly-dashboard.git
cd real-time-anomaly-dashboard
```

### 2. Install dependencies
```bash
# Server
cd server
npm ci

# Frontend
cd ../client
npm ci
```

### 3. Run the stack (development mode)
```bash
# Terminal 1 – start the Node.js backend
cd server
npm run dev   # starts Express + WS on http://localhost:4000

# Terminal 2 – start the React UI
cd ../client
npm run dev   # Vite dev server on http://localhost:3000
```

The UI will automatically connect to `ws://localhost:4000/ws` and begin displaying simulated anomaly data.

### 4. Simulate data (optional)
A lightweight data generator is shipped for quick demos:

```bash
# In a new terminal
cd server
node scripts/generator.js --rate 5   # 5 events per second
```

### 5. Build for production
```bash
# Server bundle
cd server
npm run build   # creates ./dist

# Client bundle
cd ../client
npm run build   # outputs to ./dist (served by the Node server)

# Start the compiled server
npm start
```

---  

## Complexity Analysis
| Operation | Description | Time Complexity | Space Complexity |
|-----------|-------------|-----------------|------------------|
| **Ingestion & Normalization** | Linear scan of incoming raw payload | **O(1)** per event (constant work) | **O(1)**