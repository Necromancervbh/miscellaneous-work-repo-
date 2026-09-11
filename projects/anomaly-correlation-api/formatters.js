/**
 * Output Formatting & Serialization for Anomaly Correlation API
 */
export function formatMetrics(metrics) {
  return JSON.stringify(metrics, null, 2);
}
