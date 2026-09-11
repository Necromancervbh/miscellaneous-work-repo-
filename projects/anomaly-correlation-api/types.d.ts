/**
 * Type Definitions for Anomaly Correlation API
 */
export interface ConfigOptions {
  debug?: boolean;
  threshold?: number;
  timeoutMs?: number;
}

export declare function execute(options?: ConfigOptions): Promise<any>;
