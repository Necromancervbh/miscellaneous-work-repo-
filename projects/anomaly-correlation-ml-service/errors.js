/**
 * Custom Error Definitions for Anomaly Correlation ML Service
 */
export class ProcessingError extends Error {
  constructor(message, code = 'ERR_PROCESSING') {
    super(message);
    this.name = 'ProcessingError';
    this.code = code;
  }
}
