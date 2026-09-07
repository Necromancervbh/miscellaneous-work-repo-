/**
 * Output Formatting & Serialization for Anomaly Management Platform
 */
export function formatMetrics(metrics) {
  return JSON.stringify(metrics, null, 2);
}
