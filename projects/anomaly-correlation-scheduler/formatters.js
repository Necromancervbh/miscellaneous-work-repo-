/**
 * Output Formatting & Serialization for Anomaly Correlation Forecast Scheduler
 */
export function formatMetrics(metrics) {
  return JSON.stringify(metrics, null, 2);
}
