/**
 * Output Formatting & Serialization for Anomaly Correlation ML Service
 */
export function formatMetrics(metrics) {
  return JSON.stringify(metrics, null, 2);
}
