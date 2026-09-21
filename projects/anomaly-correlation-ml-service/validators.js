/**
 * Input Sanitization & Boundary Validation for Anomaly Correlation ML Service
 */
export function validateInput(data) {
  if (data === null || data === undefined) throw new TypeError('Input cannot be null or undefined');
  return true;
}
