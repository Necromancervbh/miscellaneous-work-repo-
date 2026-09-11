/**
 * Custom Error Definitions for Anomaly Correlation API
 */
export class ProcessingError extends Error {
  constructor(message, code = 'ERR_PROCESSING') {
    super(message);
    this.name = 'ProcessingError';
    this.code = code;
  }
}
