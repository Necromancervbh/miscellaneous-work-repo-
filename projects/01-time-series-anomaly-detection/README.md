# 📈 Project: Time-Series Anomaly Detection

A standalone data science utility for detecting spikes, drops, and sensor telemetry anomalies in time-series data using moving-window trend decomposition and Z-score statistical thresholding.

## Features
- Dynamic window size moving average
- Residual variance calculation
- Outlier index mapping with confidence z-scores

## Usage
```javascript
import { detectAnomalies } from './anomalyDetector.js';

const stream = [10.2, 10.5, 9.8, 10.1, 78.4, 10.3, 9.9];
const result = detectAnomalies(stream, { windowSize: 3, zThreshold: 2.0 });

console.log(result.anomalies);
```