import { stl } from 'stl-decomp';
import * as tf from '@tensorflow/tfjs-node';

/**
 * Interface representing a single data point in the time series.
 */
export interface DataPoint {
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** Observed value */
  value: number;
}

/**
 * Options for configuring the ForecastEngine.
 */
export interface ForecastEngineOptions {
  /** Seasonal period (e.g., 24 for hourly data with daily seasonality) */
  period: number;
  /** Number of points to keep for STL decomposition (default: period * 2) */
  windowSize?: number;
  /** Process variance for the Kalman filter (Q) */
  processVariance?: number;
  /** Measurement variance for the Kalman filter (R) */
  measurementVariance?: number;
  /** Confidence level for prediction intervals (e.g., 0.95 for 95%) */
  confidenceLevel?: number;
}

/**
 * Result of a forecast request.
 */
export interface ForecastResult {
  /** Predicted value for the next timestamp */
  prediction: number;
  /** Lower bound of the confidence interval */
  lower: number;
  /** Upper bound of the confidence interval */
  upper: number;
  /** Timestamp for which the prediction is made */
  timestamp: number;
}

/**
 * Simple 1‑D Kalman filter for scalar trend values.
 *
 * State equation:      x_k = x_{k-1} + w_k,   w_k ~ N(0, Q)
 * Measurement equation: z_k = x_k + v_k,      v_k ~ N(0, R)
 *
 * The filter maintains the posterior estimate (x̂_k) and its covariance (P_k).
 */
class KalmanFilter1D {
  private x: number; // posterior state estimate
  private P: number; // posterior covariance
  private readonly Q: number; // process variance
  private readonly R: number; // measurement variance

  constructor(initialState: number, initialCovariance: number, processVariance: number, measurementVariance: number) {
    this.x = initialState;
    this.P = initialCovariance;
    this.Q = processVariance;
    this.R = measurementVariance;
  }

  /** Predict step: x̂⁻_k = x̂_{k-1},   P⁻_k = P_{k-1} + Q */
  predict(): void {
    this.P = this.P + this.Q;
    // x remains unchanged (identity state transition)
  }

  /**
   * Update step with measurement z_k.
   * @param measurement observed trend value
   */
  update(measurement: number): void {
    const K = this.P / (this.P + this.R); // Kalman gain
    this.x = this.x + K * (measurement - this.x);
    this.P = (1 - K) * this.P;
  }

  /** Current posterior state estimate */
  getState(): number {
    return this.x;
  }

  /** Current posterior covariance */
  getCovariance(): number {
    return this.P;
  }
}

/**
 * ForecastEngine processes streaming time‑series data, extracts the trend via STL,
 * feeds it into a Kalman filter, and produces point forecasts with confidence intervals.
 */
export class ForecastEngine {
  private readonly period: number;
  private readonly windowSize: number;
  private readonly kalmanFilter: KalmanFilter1D;
  private readonly confidenceZ: number; // z‑score for the desired confidence level
  private readonly dataWindow: DataPoint[] = [];
  private lastForecast: ForecastResult | null = null;

  /**
   * @param options configuration parameters
   */
  constructor(options: ForecastEngineOptions) {
    if (!options || typeof options.period !== 'number' || options.period <= 0) {
      throw new Error('Invalid period: must be a positive number.');
    }
    this.period = Math.floor(options.period);
    this.windowSize = options.windowSize && options.windowSize > this.period
      ? Math.floor(options.windowSize)
      : this.period * 2;

    const processVariance = typeof options.processVariance === 'number' && options.processVariance >= 0
      ? options.processVariance
      : 1e-3;
    const measurementVariance = typeof options.measurementVariance === 'number' && options.measurementVariance >= 0
      ? options.measurementVariance
      : 1e-2;

    // Initial state: assume zero trend, large uncertainty
    this.kalmanFilter = new KalmanFilter1D(0, 1e3, processVariance, measurementVariance);

    const confidenceLevel = typeof options.confidenceLevel === 'number' && options.confidenceLevel > 0 && options.confidenceLevel < 1
      ? options.confidenceLevel
      : 0.95;
    // Approximate z‑score for two‑tailed normal distribution
    this.confidenceZ = this.inverseNormalCdf(0.5 + confidenceLevel / 2);
  }

  /**
   * Add a new observation to the engine.
   * @param timestamp Unix timestamp in milliseconds
   * @param value observed value
   */
  addData(timestamp: number, value: number): void {
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) {
      throw new Error('Invalid timestamp: must be a positive finite number.');
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('Invalid value: must be a finite number.');
    }

    this.dataWindow.push({ timestamp, value });
    if (this.dataWindow.length > this.windowSize) {
      this.dataWindow.shift();
    }

    // Only compute forecast when we have enough points for STL
    if (this.dataWindow.length >= this.windowSize) {
      this.compute