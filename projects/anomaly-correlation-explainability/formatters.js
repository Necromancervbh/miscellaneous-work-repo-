/**
 * Output Formatting & Serialization for Anomaly Correlation Explainability Service
 */
export function formatMetrics(metrics) {
  return JSON.stringify(metrics, null, 2);
}
