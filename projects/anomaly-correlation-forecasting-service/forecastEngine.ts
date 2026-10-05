import { TaskQueue, TaskHandler } from 'orchestrator'; // Adjust import path as needed

/**
 * Options for configuring the Kalman filter.
 */
export interface KalmanFilterOptions {
  /** Process (model) variance Q. Controls how much we trust the model dynamics. */
  processVariance?: number;
  /** Measurement variance R. Controls how much we trust the observations. */
  measurementVariance?: number;
  /** Initial state estimate x₀. */
  initialState?: number;
  /** Initial estimate covariance P₀. */
  initialCovariance?: number;
}

/**
 * Options for the forecasting function.
 */
export interface ForecastOptions extends KalmanFilterOptions {}

/**
 * Scalar Kalman filter for 1‑D time‑series.
 *
 * State transition model:   xₖ = xₖ₋₁ + wₖ,   wₖ ~ N(0, Q)
 * Observation model:       zₖ = xₖ + vₖ,      vₖ ~ N(0, R)
 *
 * Prediction step:
 *   x̂ₖ|ₖ₋₁ = x̂ₖ₋₁|ₖ₋₁
 *   Pₖ|ₖ₋₁ = Pₖ₋₁|ₖ₋₁ + Q
 *
 * Update step:
 *   Kₖ = Pₖ|ₖ₋₁ / (Pₖ|ₖ₋₁ + R)
 *   x̂ₖ|ₖ = x̂ₖ|ₖ₋₁ + Kₖ (zₖ - x̂ₖ|ₖ₋₁)
 *   Pₖ|ₖ = (1 - Kₖ) Pₖ|ₖ₋₁
 */
export class KalmanFilter {
  private x: number; // State estimate (x̂)
  private P: number; // Estimate covariance (P)
  private readonly Q: number; // Process variance
  private readonly R: number; // Measurement variance
  private initialized: boolean;

  /**
   * Creates a new Kalman filter instance.
   *
   * @param options Configuration options.
   */
  constructor(options: KalmanFilterOptions = {}) {
    const {
      processVariance = 1e-5,
      measurementVariance = 1e-2,
      initialState = 0,
      initialCovariance = 1,
    } = options;

    if (!Number.isFinite(processVariance) || processVariance <= 0) {
      throw new Error('processVariance must be a positive finite number.');
    }
    if (!Number.isFinite(measurementVariance) || measurementVariance <= 0) {
      throw new Error('measurementVariance must be a positive finite number.');
    }
    if (!Number.isFinite(initialState)) {
      throw new Error('initialState must be a finite number.');
    }
    if (!Number.isFinite(initialCovariance) || initialCovariance <= 0) {
      throw new Error('initialCovariance must be a positive finite number.');
    }

    this.Q = processVariance;
    this.R = measurementVariance;
    this.x = initialState;
    this.P = initialCovariance;
    this.initialized = true;
  }

  /**
   * Performs the prediction step and returns the predicted state.
   *
   * @returns Predicted state (1‑step ahead forecast).
   */
  predict(): number {
    if (!this.initialized) {
      throw new Error('Kalman filter not initialized.');
    }
    // x̂ₖ|ₖ₋₁ = x̂ₖ₋₁|ₖ₋₁ (identity for constant model)
    // Pₖ|ₖ₋₁ = Pₖ₋₁|ₖ₋₁ + Q
    this.P += this.Q;
    return this.x;
  }

  /**
   * Incorporates a new measurement into the filter.
   *
   * @param measurement Observed value zₖ.
   */
  update(measurement: number): void {
    if (!this.initialized) {
      throw new Error('Kalman filter not initialized.');
    }
    if (!Number.isFinite(measurement)) {
      throw new Error('Measurement must be a finite number.');
    }

    // Kₖ = Pₖ|ₖ₋₁ / (Pₖ|ₖ₋₁ + R)
    const K = this.P / (this.P + this.R);

    // x̂ₖ|ₖ = x̂ₖ|ₖ₋₁ + K (zₖ - x̂ₖ|ₖ₋₁)
    this.x = this.x + K * (measurement - this.x);

    // Pₖ|ₖ = (1 - K) Pₖ|ₖ₋₁
    this.P = (1 - K) * this.P;
  }

  /**
   * Executes a full filter cycle: predict then update.
   *
   * @param measurement New observation.
   * @returns Predicted state before the measurement was incorporated.
   */
  step(measurement: number): number {
    const prediction = this.predict();
    this.update(measurement);
    return prediction;
  }
}

/**
 * Generates 1‑step ahead forecasts for a series of anomaly scores.
 *
 * @param scores Array of anomaly scores (observations) ordered chronologically.
 * @param options Optional configuration for the Kalman filter.
 * @returns Promise that resolves to an array of forecasts, each forecast corresponds to the prediction made before seeing the respective observation.
 */
export async function forecastAnomalies(
  scores: number[],
  options: ForecastOptions = {}
): Promise<number[]> {
  // Input validation
  if (!Array.isArray(scores)) {
    throw new TypeError('scores must be an array of numbers.');
  }
  if (scores.length === 0) {
    throw new Error('scores array must contain at least one element.');
  }
  for (let i = 0; i < scores.length; i++) {
    const v = scores[i];
    if (typeof v !== 'number'