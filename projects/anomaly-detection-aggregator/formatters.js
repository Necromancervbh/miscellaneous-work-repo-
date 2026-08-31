/**
 * Output Formatting & Serialization for Anomaly Detection Aggregator
 */
export function formatMetrics(metrics) {
  return JSON.stringify(metrics, null, 2);
}
