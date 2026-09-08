# Anomaly Correlation Engine  

**Category:** Data Science  
**Stack:** TypeScript • Node.js • PostgreSQL  

Detects correlated anomalies across multiple streams in real time, turning noisy sensor feeds, log files, or financial tick data into actionable insights.

---  

## Overview  

The Anomaly Correlation Engine (ACE) continuously ingests time‑series events from any number of sources, runs lightweight per‑stream anomaly detectors, and then **joins** those anomalies across streams to surface hidden relationships (e.g., a temperature spike that always precedes a pressure drop).  

Key features  

| ✅ | Feature |
|---|---------|
| **Real‑time** | Sub‑second latency from event arrival to correlation output |
| **Scalable ingestion** | Horizontal scaling via Node.js worker pools |
| **Pluggable detectors** | Built‑in statistical, ML‑based, or custom detectors |
| **Persistent storage** | PostgreSQL stores raw events, detected anomalies, and correlation graphs |
| **REST & WebSocket API** | Query current anomalies, subscribe to correlation streams |
| **Extensible architecture** | Add new streams, detectors, or correlation rules without code changes |

---  

## Theory / Architecture  

```mermaid
graph TD
    A[Ingestion Service] -->|Kafka / HTTP| B[Event Buffer (Redis)]
    B --> C[Per‑Stream Anomaly Detector]
    C --> D[Anomaly Store (PostgreSQL)]
    D --> E[Correlation Engine]
    E --> F[Correlation Store (PostgreSQL)]
    E --> G[Alert/Notification Service]
    G --> H[REST / WebSocket API]
    style A fill:#f9f,stroke:#333,stroke-width:2px
    style C fill:#bbf,stroke:#333,stroke-width:2px
    style E fill:#bfb,stroke:#333,stroke-width:2px
```

### Core components  

1. **Ingestion Service** – Accepts JSON events via HTTP or Kafka, normalises timestamps, and writes to a fast buffer (Redis Streams).  
2. **Per‑Stream Anomaly Detector** – Runs a configurable detector (e.g., Z‑score, Isolation Forest, LSTM) on a sliding window (`W` seconds). Emits an *anomaly record* when the detector’s confidence exceeds a threshold.  
3. **Anomaly Store** – PostgreSQL table `anomalies` holds `{id, stream_id, ts, score, payload}` and is indexed on `ts` and `stream_id`.  
4. **Correlation Engine** – Periodically (or on‑demand) pulls recent anomalies, builds a **temporal co‑occurrence matrix**, and applies statistical tests (Pearson, Mutual Information) or graph‑based clustering to discover correlated groups.  
5. **Correlation Store** – Persists discovered groups in `correlations` with a versioned graph representation for auditability.  
6. **Alert/Notification Service** – Emits WebSocket events or pushes to external systems (PagerDuty, Slack) when a correlation crosses a severity threshold.  

### Detection & Correlation algorithm (high‑level)  

```text
for each incoming event e:
    buffer[e.stream] ← e
    if buffer[e.stream] has ≥ W samples:
        score ← detector(buffer[e.stream])
        if score > THRESHOLD:
            INSERT INTO anomalies ...

every T_corr seconds:
    recent ← SELECT * FROM anomalies WHERE ts > now() - CORR_WINDOW
    M ← build co‑occurrence matrix (streams × time bins)
    for each pair (i, j):
        r ← correlation_metric(M[i], M[j])
        if |r| > CORR_TH:
            INSERT/UPDATE correlations (i, j, r)
```

---  

## Quickstart  

### Prerequisites  

| Tool | Minimum version |
|------|-----------------|
| Node.js | 18.x |
| Yarn (or npm) | 1.22+ |
| PostgreSQL | 13+ |
| Docker (optional) | 20.10+ |

### 1. Clone & install  

```bash
git clone https://github.com/yourorg/anomaly-correlation-engine.git
cd anomaly-correlation-engine
yarn install            # or `npm