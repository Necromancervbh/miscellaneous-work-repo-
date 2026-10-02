/**
 * Output Formatting & Serialization for Anomaly Correlation Orchestrator
 */
export function formatMetrics(metrics) {
  return JSON.stringify(metrics, null, 2);
}
