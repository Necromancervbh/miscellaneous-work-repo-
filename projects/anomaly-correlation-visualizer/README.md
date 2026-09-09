# Anomaly Correlation Visualizer  

**Category:** Data Science  
**Stack:** Node.js • TypeScript • D3.js  

An interactive web UI that lets analysts explore and compare anomaly patterns across multiple sensors in real time. Drag‑and‑drop sensor streams, adjust correlation windows, and instantly see heat‑maps, network graphs, and time‑aligned scatter plots powered by D3.

---  

## Overview  

Modern IoT deployments generate dozens to hundreds of sensor streams per device. Detecting when anomalies in one sensor are statistically linked to anomalies in another is crucial for predictive maintenance, fault diagnosis, and root‑cause analysis.  

The **Anomaly Correlation Visualizer** provides:

| Feature | Benefit |
|---------|----------|
| **Multi‑sensor selection** – pick any combination of streams from a catalog. | No need to pre‑define pairings. |
| **Dynamic correlation window** – slide a time‑window slider to see short‑ vs. long‑term relationships. | Immediate insight into temporal lag effects. |
| **Heat‑map matrix** – colour‑coded Pearson / Spearman scores for all selected pairs. | Spot strong/weak relationships at a glance. |
| **Network graph** – nodes = sensors, edge thickness = correlation magnitude. | Visualise the overall correlation topology. |
| **Time‑aligned scatter view** – zoom into a specific window and inspect point‑wise behaviour. | Validate statistical findings with raw data. |
| **Export** – download CSV of correlation matrix or PNG of visualisations. | Easy integration with reports. |

The UI is built as a single‑page application (SPA) that consumes a lightweight Node.js/Express API delivering pre‑processed anomaly flags and timestamps. All heavy lifting (correlation computation) is performed on the server in TypeScript, keeping the browser responsive even with >10 000 data points per sensor.

---  

## Theory & Architecture  

### 1. Data Model  

- **SensorReading**: `{ sensorId: string, timestamp: number, value: number }`  
- **AnomalyFlag**: `{ sensorId: string, timestamp: number, isAnomaly: boolean }`  

Anomalies are pre‑computed by an external detection pipeline (e.g., isolation forest, statistical thresholding) and stored in a time‑series DB (InfluxDB / TimescaleDB). The visualizer only queries the binary flag series.

### 2. Correlation Computation  

For any two sensors *A* and *B* within a sliding window *W*:

1. Extract the binary anomaly vectors `a = [a₁,…,aₙ]`, `b = [b₁,…,bₙ]` where `aᵢ, bᵢ ∈ {0,1}`.  
2. Compute **Pearson** correlation:  

\[
\rho_{AB} = \frac{\sum_{i=1}^{n}(a_i-\bar a)(b_i-\bar b)}{\sqrt{\sum_{i=1}^{n}(a_i-\bar a)^2}\sqrt{\sum_{i=1}^{n}(b_i-\bar b)^2}}
\]

3. Optionally compute **Spearman** rank correlation for non‑linear monotonic relationships.  

The server caches pairwise results for the most recent window to avoid recomputation when the user only pans the view.

### 3. System Diagram  

```
+-------------------+        HTTP/JSON        +-------------------+
|   Front‑end SPA   | <--------------------> |   Node.js API     |
| (React + D3.js)   |                         | (TS)              |
+-------------------+                         +-------------------+
        |                                          |
        | REST endpoints                           |
        v                                          v
+-------------------+        SQL/TSDB        +-------------------+
|  TimescaleDB /    | <--------------------> |  Correlation      |
|  InfluxDB         |   anomaly flag series  |  Service (TS)     |
+-------------------+                         +-------------------+
```

- **Front‑end** renders D3 visualisations and handles user interaction.  
- **API** aggregates flags, computes correlations, and returns JSON payloads (`matrix`, `edges`, `scatter`).  
- **Correlation Service** runs in a separate worker thread to keep the event loop non‑blocking.

### 4. Key Packages  

| Package | Purpose |
|---------|---------|
| `express` | HTTP server & routing |
| `typescript` | Static typing for reliability |
| `pg` / `influx` | DB drivers |
| `d3@7` | Scalable SVG/Canvas visualisations |
| `react` + `react‑router` | UI scaffolding |
| `worker_threads` | Off‑load heavy correlation loops |
| `jest` + `ts-jest` | Unit / integration tests |

---  

## Quickstart  

### Prerequisites  

- Node.js **>= 18**  
- Yarn or npm  
- Access to a TimescaleDB/InfluxDB instance containing anomaly flag tables (`anomalies(sensor_id, ts, is_anomaly)`)  

### 1. Clone & Install  

```bash
git clone https://github.com/yourorg/anomaly-correlation-visualizer.git
cd anomaly-correlation-visual