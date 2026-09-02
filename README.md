# 📂 Miscellaneous Work & Projects

> Personal engineering workspace containing modular projects across **Data Science**, **Full-Stack Web Development**, **Machine Learning prototypes**, and **Backend tools**.

---

## 🗂️ Project Directory

All projects are organized in individual self-contained folders inside [`projects/`](./projects/):

| Project | Category | Tech / Stack | Description |
| :--- | :--- | :--- | :--- |
| [**Real‑Time Anomaly Alerting Service**](./projects/anomaly-detection-alerting/) | `Data Science` | Node.js / TypeScript / Python | Detects anomalies and sends alerts via API and WebSocket. |
| [**Real‑Time Anomaly Detection Pipeline**](./projects/anomaly-detection-pipeline/) | `Data Science` | TypeScript / Node.js | Streaming ETL that aggregates, filters, and visualizes anomalies in real time. |
| [**Real‑Time Anomaly Detection Dashboard**](./projects/anomaly-detection-dashboard/) | `Data Science` | TypeScript / Node.js / React | Unified UI for streaming anomaly detection and analytics. |
| [**Anomaly Detection Aggregator**](./projects/anomaly-detection-aggregator/) | `Data Science` | TypeScript / Node.js | Aggregates multi‑model anomalies via WebSocket, exposes unified API. |
| [**Anomaly Detection Orchestrator**](./projects/anomaly-detection-orchestrator/) | `Full-Stack` | Node.js / TypeScript / WebSocket | Unified API merging STL and Kalman filters with real‑time streaming. |
| [**STL Anomaly Detection Client SDK**](./projects/stl-anomaly-detection-client/) | `Backend Tools` | TypeScript / Node.js / Axios | A lightweight TypeScript client library to consume the STL Anomaly Detection Service API with validation, retry, and batch processing support. |
| [**STL Anomaly Detection Service API**](./projects/stl-anomaly-detection-service/) | `Full-Stack` | Node.js / Express / TypeScript | REST API that runs STL‑based time‑series anomaly detection and returns timestamps of outliers. |
| [**01. Time-Series Anomaly Detection**](./projects/01-time-series-anomaly-detection/) | `Data Science` | JavaScript / Stats | Moving-window STL trend decomposition with Z-score outlier detection for streaming metrics. |
| [**02. Async Functional Toolkit**](./projects/02-async-functional-toolkit/) | `Full-Stack / Utils` | JavaScript / Async | Resilient exponential retry backoff, debounce, throttle, and functional pipeline combinators. |

---

## 🛠️ Overview of Domains

- **📊 Data Science & Analytics**: Exploratory scripts, statistics algorithms, clustering, time-series forecasting, and data transformation tools.
- **🌐 Full-Stack & APIs**: REST endpoints, authentication middleware, database helpers, and reactive frontend state stores.
- **🤖 Machine Learning & AI**: Vector similarity search, tokenizers, regression models, and text processing utilities.
- **⚙️ Backend & Automation Primitives**: Queue workers, rate limiters, caching strategies, and concurrency primitives.

---

## 📄 License
MIT © Contributors