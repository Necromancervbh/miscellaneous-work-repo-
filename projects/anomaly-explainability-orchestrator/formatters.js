/**
 * Output Formatting & Serialization for Anomaly Explainability Orchestrator
 */
export function formatMetrics(metrics) {
  return JSON.stringify(metrics, null, 2);
}
