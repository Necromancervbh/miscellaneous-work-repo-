/**
 * Output Formatting & Serialization for Anomaly Correlation Notifier
 */
export function formatMetrics(metrics) {
  return JSON.stringify(metrics, null, 2);
}
