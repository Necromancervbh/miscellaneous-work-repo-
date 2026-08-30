/**
 * Time-Series Anomaly Detection Utility
 * Uses moving window STL decomposition and Z-score thresholding.
 */

export function calculateMovingAverage(data, windowSize = 5) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    const start = Math.max(0, i - Math.floor(windowSize / 2));
    const end = Math.min(data.length, i + Math.ceil(windowSize / 2));
    const window = data.slice(start, end);
    const avg = window.reduce((a, b) => a + b, 0) / window.length;
    result.push(avg);
  }
  return result;
}

export function detectAnomalies(series, { windowSize = 5, zThreshold = 2.5 } = {}) {
  if (!series || series.length === 0) return { anomalies: [], cleanSeries: [] };

  const trend = calculateMovingAverage(series, windowSize);
  const residuals = series.map((val, idx) => val - trend[idx]);

  const mean = residuals.reduce((a, b) => a + b, 0) / residuals.length;
  const variance = residuals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / residuals.length;
  const stdDev = Math.sqrt(variance) || 1e-9;

  const anomalies = [];
  residuals.forEach((res, index) => {
    const zScore = Math.abs((res - mean) / stdDev);
    if (zScore >= zThreshold) {
      anomalies.push({
        index,
        value: series[index],
        expected: trend[index],
        zScore: parseFloat(zScore.toFixed(3)),
      });
    }
  });

  return {
    totalPoints: series.length,
    anomaliesFound: anomalies.length,
    anomalies,
  };
}