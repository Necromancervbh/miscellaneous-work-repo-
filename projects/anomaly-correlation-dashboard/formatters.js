/**
 * Output Formatting & Serialization for Anomaly Correlation Dashboard
 */
export function formatMetrics(metrics) {
  return JSON.stringify(metrics, null, 2);
}
