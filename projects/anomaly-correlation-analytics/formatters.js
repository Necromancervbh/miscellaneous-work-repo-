/**
 * Output Formatting & Serialization for Anomaly Correlation Analytics Service
 */
export function formatMetrics(metrics) {
  return JSON.stringify(metrics, null, 2);
}
