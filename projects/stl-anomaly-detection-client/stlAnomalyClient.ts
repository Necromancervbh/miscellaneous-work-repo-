import axios, { AxiosInstance, AxiosResponse } from 'axios';

/**
 * Types representing the request payload sent to the STL Anomaly Detection Service.
 */
interface STLRequestPayload {
  /**
   * Numeric time‑series values.
   */
  series: number[];
  /**
   * Optional timestamps (Unix epoch ms). If omitted the service will assume regular intervals.
   */
  timestamps?: number[];
  /**
   * Z‑score threshold for anomaly classification. Mirrors the server default if omitted.
   */
  threshold?: number;
}

/**
 * Types representing the response returned by the service.
 */
export interface STLAnomalyResult {
  /**
   * Original timestamps (or generated indices) aligned with the series.
   */
  timestamps: number[];
  /**
   * Original series values.
   */
  values: number[];
  /**
   * Boolean flag per point – true if the point is classified as an anomaly.
   */
  anomalies: boolean[];
}

/**
 * Configuration options for the client instance.
 */
export interface STLClientOptions {
  /** Base URL of the STL anomaly detection service, e.g. 'http://localhost:3000/api'. */
  baseURL: string;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** Maximum number of retry attempts for transient failures. */
  maxRetries?: number;
  /** Base back‑off delay in ms for exponential retry (default 200 ms). */
  backoffBaseMs?: number;
}

/**
 * Helper utilities for runtime validation.
 */
function isNumericArray(arr: any[]): arr is number[] {
  return Array.isArray(arr) && arr.every((v) => typeof v === 'number' && !Number.isNaN(v));
}

function validateSeries(series: number[]): void {
  if (!Array.isArray(series) || series.length === 0) {
    throw new Error('Series must be a non‑empty array of numbers.');
  }
  if (!isNumericArray(series)) {
    throw new Error('Series contains non‑numeric or NaN values.');
  }
}

function validateTimestamps(timestamps: number[] | undefined, seriesLength: number): void {
  if (timestamps === undefined) return;
  if (!Array.isArray(timestamps) || timestamps.length !== seriesLength) {
    throw new Error('Timestamps must be an array with the same length as the series.');
  }
  if (!isNumericArray(timestamps)) {
    throw new Error('Timestamps contain non‑numeric or NaN values.');
  }
}

/**
 * STLAnomalyClient provides a thin wrapper around the REST API exposing the STL
 * decomposition based anomaly detector. It performs input validation, automatic
 * exponential‑backoff retries and offers both single‑series and batch interfaces.
 */
export class STLAnomalyClient {
  private readonly http: AxiosInstance;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;

  constructor(options: STLClientOptions) {
    if (!options || typeof options.baseURL !== 'string') {
      throw new Error('STLClientOptions with a valid baseURL is required.');
    }
    this.http = axios.create({
      baseURL: options.baseURL,
      timeout: options.timeoutMs ?? 5000,
      headers: { 'Content-Type': 'application/json' },
    });
    this.maxRetries = options.maxRetries ?? 3;
    this.backoffBaseMs = options.backoffBaseMs ?? 200;
  }

  /**
   * Detect anomalies for a single time‑series.
   *
   * @param series Numeric values of the time‑series.
   * @param timestamps Optional timestamps aligned with `series`.
   * @param threshold Optional z‑score threshold; if omitted the server default is used.
   * @returns Promise resolving to {@link STLAnomalyResult}.
   */
  async detect(
    series: number[],
    timestamps?: number[],
    threshold?: number
  ): Promise<STLAnomalyResult> {
    // ---- Input validation ----
    validateSeries(series);
    validateTimestamps(timestamps, series.length);
    if (threshold !== undefined && (typeof threshold !== 'number' || Number.isNaN(threshold))) {
      throw new Error('Threshold must be a valid number when provided.');
    }

    const payload: STLRequestPayload = { series, timestamps, threshold };
    const response = await this.requestWithRetry<STLAnomalyResult>('/stl-anomaly', payload);
    return response;
  }

  /**
   * Detect anomalies for multiple series in parallel with limited concurrency.
   *
   * @param batches Array of objects each containing `series` and optional `timestamps`.
   * @param concurrency Maximum number of concurrent HTTP requests (default 5).
   * @returns Promise resolving to an array of {@link STLAnomalyResult} in the same order.
   */
  async batchDetect(
    batches: { series: number[]; timestamps?: number[]; threshold?: number }[],
    concurrency: number = 5
  ): Promise<STLAnomalyResult[]> {
    if (!Array.isArray(batches) || batches.length === 0) {
      throw new Error('Batches must be a non‑empty array.');
    }
    // Simple semaphore implementation for concurrency control.
    const results: STLAnomalyResult[] = new Array(batches.length);
    let index = 0;
    const workers = new Array(Math.min(concurrency, batches.length)).fill(null).map(async () => {
      while (true) {
        const current = index++;
        if (current >= batches.length) break;
        const { series, timestamps, threshold } = batches[current];
        results[current] = await this.detect(series, timestamps, threshold);
      }
    });
    await Promise.all(workers);
    return results;
  }

  /**
   * Internal helper that performs an HTTP POST with exponential back‑off.
   */
  private async requestWithRetry<T>(endpoint: string, payload: any): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        const resp: AxiosResponse<T> = await this.http.post(endpoint, payload);
        return resp.data;
      } catch (err: any) {
        const isTransient = err.code === 'ECONNABORTED' || err.response?.status >= 500;
        if (!isTransient || attempt >= this.maxRetries) {
          // Re‑throw non‑transient errors or after exhausting retries.
          throw new Error(`STL anomaly request failed after ${attempt + 1} attempt(s): ${err.message}`);
        }
        const delay = this.backoffBaseMs * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
        attempt++;
      }
    }
  }
}

/**
 * Example usage (uncomment for local testing):
 *
 * // const client = new STLAnomalyClient({ baseURL: 'http://localhost:3000/api' });
 * // const series = [10, 12, 13, 50, 14, 15];
 * // const result = await client.detect(series);
 * // console.log(result);
 */
