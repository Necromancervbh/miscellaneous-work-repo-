/**
 * Input Sanitization & Boundary Validation for Graph Explorer for Anomaly Correlations
 */
export function validateInput(data) {
  if (data === null || data === undefined) throw new TypeError('Input cannot be null or undefined');
  return true;
}
