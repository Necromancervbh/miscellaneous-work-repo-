import { createClient, RedisClientType } from 'redis';
import PCA from 'ml-pca';
import { EventEmitter } from 'events';

/**
 * Raw time‑series data point.
 */
export interface RawData {
  /** Unix epoch in milliseconds */
  timestamp: number;
  /** Multivariate measurement */
  values: number[];
}

/**
 * Configuration options for the ingestion pipeline.
 */
export interface PipelineOptions {
  /** Redis connection URL (e.g., redis://localhost:6379) */
  redisUrl: string;
  /** Redis stream key where batched vectors will be published */
  streamKey: string;
  /** Number of transformed vectors per batch */
  batchSize: number;
  /** Maximum number of pending batches awaiting Redis acknowledgement */
  maxPendingBatches: number;
  /** Number of samples to keep for PCA fitting */
  pcaWindowSize: number;
  /** Kalman filter parameters per dimension */
  kalman?: {
    /** Process noise covariance (Q) */
    processNoise: number;
    /** Measurement noise covariance (R) */
    measurementNoise: number;
    /** Initial estimate error covariance (P0) */
    initialErrorCovariance: number;
  };
}

/**
 * Simple 1‑D Kalman filter.
 *
 * State equation:   xₖ = xₖ₋₁
 * Measurement:      zₖ = xₖ + vₖ,   vₖ ~ N(0, R)
 *
 * The filter maintains:
 *   - x̂ₖ : posterior estimate
 *   - Pₖ : posterior error covariance
 *
 * Prediction:
 *   x̂ₖ⁻ = x̂ₖ₋₁
 *   Pₖ⁻  = Pₖ₋₁ + Q
 *
 * Update:
 *   Kₖ   = Pₖ⁻ / (Pₖ⁻ + R)
 *   x̂ₖ  = x̂ₖ⁻ + Kₖ (zₖ - x̂ₖ⁻)
 *   Pₖ   = (1 - Kₖ) Pₖ⁻
 */
class KalmanFilter1D {
  private q: number; // process noise covariance
  private r: number; // measurement noise covariance
  private x: number; // posterior estimate
  private p: number; // posterior error covariance
  private initialized: boolean = false;

  constructor(
    processNoise: number,
    measurementNoise: number,
    initialErrorCovariance: number,
    initialState?: number
  ) {
    this.q = processNoise;
    this.r = measurementNoise;
    this.p = initialErrorCovariance;
    this.x = initialState ?? 0;
  }

  /**
   * Apply the filter to a new measurement.
   * @param measurement Observed value zₖ
   * @returns Filtered estimate x̂ₖ
   */
  public filter(measurement: number): number {
    // Prediction step
    const xPred = this.x; // x̂ₖ⁻ = x̂ₖ₋₁ (identity system)
    const pPred = this.p + this.q; // Pₖ⁻ = Pₖ₋₁ + Q

    // Update step
    const k = pPred / (pPred + this.r); // Kalman gain Kₖ
    const xUpd = xPred + k * (measurement - xPred);
    const pUpd = (1 - k) * pPred;

    this.x = xUpd;
    this.p = pUpd;
    this.initialized = true;
    return this.x;
  }
}

/**
 * Multi‑dimensional Kalman filter that wraps a 1‑D filter per dimension.
 */
class MultiDimKalmanFilter {
  private filters: KalmanFilter1D[];

  constructor(
    dim: number,
    processNoise: number,
    measurementNoise: number,
    initialErrorCovariance: number
  ) {
    this.filters = Array.from({ length: dim }, () =>
      new KalmanFilter1D(
        processNoise,
        measurementNoise,
        initialErrorCovariance
      )
    );
  }

  /**
   * Filter a vector of measurements.
   * @param vector Input values per dimension.
   * @returns Filtered vector.
   */
  public filter(vector: number[]): number[] {
    if (vector.length !== this.filters.length) {
      throw new Error(
        `Dimension mismatch: expected ${this.filters.length}, got ${vector.length}`
      );
    }
    return vector.map((v, i) => this.filters[i].filter(v));
  }
}

/**
 * IngestionPipeline reads raw time‑series data, smooths it with a Kalman filter,
 * reduces dimensionality with PCA, batches the results and publishes them to a
 * Redis stream while respecting back‑pressure.
 */
export class IngestionPipeline extends EventEmitter {
  private readonly options: PipelineOptions;
  private readonly redisClient: RedisClientType;
  private readonly kalmanFilter?: MultiDimKalmanFilter;
  private pcaModel?: PCA;
  private readonly pcaWindow: number[][];
  private pendingBatches: number = 0;
  private stopped: boolean = false;

  /**
   * Construct a new pipeline.
   * @param options Configuration parameters.
   */
  constructor(options: PipelineOptions) {
    super();
    this.validateOptions(options);
    this.options = options;
    this.redisClient = createClient({ url: options.redisUrl });
    this.pcaWindow = [];

    if (options.kalman) {
      // Kalman filter will be lazily instantiated after first sample to know dimensionality.
      this.kalmanFilter = undefined;
    }
  }

  /**
   * Validate configuration options.
   */
  private validateOptions(opts: PipelineOptions): void {
    if (!opts.redisUrl) throw new Error('redisUrl is required');
    if (!opts.streamKey) throw new Error('streamKey is required');
    if (opts.batchSize <= 0) throw new Error('batchSize must be > 0');
    if (opts.maxPendingBatches <= 0)
      throw new Error('maxPendingBatches must be > 0');
    if (opts.pcaWindowSize <= 0)
      throw new Error('pcaWindowSize must be > 0');
    if (opts.kalman) {
      const { processNoise, measurementNoise, initialErrorCovariance } =
        opts.kalman;
      if (processNoise < 0 || measurementNoise < 0 || initialErrorCovariance < 0) {
        throw new Error('Kalman parameters must be non‑negative');
      }
    }
  }

  /**
   * Connect to Redis.