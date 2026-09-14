# Anomaly Correlation Evaluation Service
**Category:** Data Science  
**Stack:** TypeScript / Node.js  

A lightweight, extensible service that computes cross‑validated performance metrics and generates visual reports for anomaly detection pipelines. Plug‑and‑play with any model that emits binary or probabilistic anomaly scores.

---  

## Overview
The Anomaly Correlation Evaluation Service (ACES) automates the end‑to‑end evaluation of anomaly detection workflows:

| Feature | Description |
|---------|-------------|
| **Cross‑validation** | K‑fold and rolling‑window schemes for robust metric estimation. |
| **Metric suite** | Precision, Recall, F1, ROC‑AUC, PR‑AUC, and the *Anomaly Correlation Score* (a Pearson‑style correlation between true labels and anomaly scores). |
| **Visual reports** | Interactive HTML dashboards (ROC/PR curves, score distributions, confusion matrices). |
| **Pluggable adapters** | Connectors for CSV, Parquet, streaming APIs, or custom data loaders. |
| **Zero‑config mode** | Run a full evaluation with a single CLI command. |

ACES is designed for data scientists and ML engineers who need reproducible, statistically sound evaluation without writing boilerplate code.

---  

## Theory / Architecture  

### 1. Core Evaluation Pipeline
```
+-------------------+      +-------------------+      +-------------------+
|   Data Loader     | ---> |   CV Splitter     | ---> |   Metric Engine   |
+-------------------+      +-------------------+      +-------------------+
                                   |
                                   v
                         +-------------------+
                         |   Report Builder  |
                         +-------------------+
```

* **Data Loader** – Abstract interface (`IDataLoader`) that yields a stream of `{timestamp, score, label}` records. Built‑in loaders for CSV, JSONL, and Arrow files; custom loaders can be registered via `registerLoader()`.  

* **CV Splitter** – Implements `ICrossValidator`. Supports:
  * **K‑Fold** (stratified for imbalanced labels)
  * **TimeSeriesRolling** (expanding or sliding windows)
  * **Monte‑Carlo** (random subsampling)

* **Metric Engine** – Stateless calculators that accept a fold’s predictions and ground truth, returning a `MetricsResult`:
  * **Binary metrics** – Precision, Recall, F1, Accuracy.
  * **Ranking metrics** – ROC‑AUC, PR‑AUC.
  * **Correlation metric** – `AnomalyCorrelation = corr(y, s)` where `y` are binary labels and `s` are raw scores (Pearson by default, configurable to Spearman).

* **Report Builder** – Consumes per‑fold metrics, aggregates statistics (mean ± std), and renders an HTML dashboard using **Plotly.js** and **Bootstrap**. The dashboard is self‑contained (single HTML file) for easy sharing.

### 2. Extensibility Hooks
| Hook | Purpose | Example |
|------|---------|---------|
| `registerMetric(name, fn)` | Add custom metric calculations. | `registerMetric('BrierScore', (y, s) => …)` |
| `registerRenderer(name, fn)` | Plug in alternative visualizations (e.g., D3, Vega). | `registerRenderer('heatmap', renderHeatmap)` |
| `middleware` | Pre‑process scores/labels (e.g., clipping, smoothing). | `app.use((data) => data.map(d => ({...d, score: Math.max(0, d.score)})))` |

---  

## Quickstart  

### 1. Install
```bash
# Using npm
npm i -g anomaly-correlation-eval

# Or as a project dependency
npm i anomaly-correlation-eval
```

### 2. Run the CLI (Zero‑config)
```bash
# Evaluate a CSV file with columns: timestamp, score, label
aces evaluate --input data/alerts.csv --k 5 --output report.html
```
The command will:
1. Load the CSV.
2. Perform 5‑fold stratified CV.
3. Compute all built‑in metrics.
4. Write `report.html` to the current directory.

### 3. Use as a library (TypeScript)

```ts
import { CsvLoader, KFoldValidator, Evaluator, renderHtmlReport } from 'anomaly-correlation-eval';

// 1️⃣ Load data
const loader = new CsvLoader('data/alerts.csv', {
  timestamp: 'ts',
  score: 'anom_score',
  label: 'is_anomaly',
});
const dataset = await loader.load(); // returns Array<{timestamp: Date, score: number, label: number}>

// 2️⃣ Set up cross‑validation
const cv = new KFoldValidator(5, { stratify: true });

// 3️⃣ Create evaluator with default metrics
const evaluator = new Evaluator(cv);

// 4️⃣ Run evaluation
const results = await evaluator.evaluate(dataset);

// 5️⃣ Generate interactive HTML report
const html = renderHtmlReport(results, {
  title: 'An