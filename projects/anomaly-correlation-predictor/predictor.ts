import * as tf from '@tensorflow/tfjs-node';
import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import * as http from 'http';

/**
 * Interface representing a single metric observation.
 */
export interface Metric {
  /** Unix epoch time in milliseconds */
  timestamp: number;
  /** Observed value */
  value: number;
}

/**
 * Simple 1‑D Kalman filter with constant velocity model.
 *
 * State vector: x = [position, velocity]^T
 *
 * State transition:
 *   x_k = F * x_{k-1} + w,   w ~ N(0, Q)
 *   F = [[1, Δt],
 *        [0, 1 ]]
 *
 * Observation model:
 *   z_k = H * x_k + v,       v ~ N(0, R)
 *   H = [1, 0]
 *
 * The filter maintains mean (μ) and covariance (Σ) of the state.
 */
class KalmanFilter {
  private stateMean: tf.Tensor1D; // shape [2]
  private stateCov: tf.Tensor2D; // shape [2,2]
  private readonly processNoiseCov: tf.Tensor2D; // Q
  private readonly observationNoiseCov: tf.Scalar; // R
  private lastTimestamp: number | null = null;

  constructor(
    initialMean: number = 0,
    initialVelocity: number = 0,
    initialCovariance: number = 1,
    processNoiseVar: number = 1e-3,
    observationNoiseVar: number = 1e-2
  ) {
    this.stateMean = tf.tensor1d([initialMean, initialVelocity]);
    this.stateCov = tf.tensor2d([
      [initialCovariance, 0],
      [0, initialCovariance],
    ]);
    this.processNoiseCov = tf.tensor2d([
      [processNoiseVar, 0],
      [0, processNoiseVar],
    ]);
    this.observationNoiseCov = tf.scalar(observationNoiseVar);
  }

  /**
   * Predict step based on elapsed time.
   * @param deltaT Time difference in seconds.
   */
  private predict(deltaT: number): void {
    const F = tf.tensor2d([
      [1, deltaT],
      [0, 1],
    ]);
    // μ_pred = F * μ
    const predictedMean = tf.matMul(F, this.stateMean.reshape([2, 1])).reshape([2]);
    // Σ_pred = F * Σ * F^T + Q
    const Ft = tf.transpose(F);
    const predictedCov = tf.add(
      tf.matMul(tf.matMul(F, this.stateCov), Ft),
      this.processNoiseCov
    );

    this.stateMean.dispose();
    this.stateCov.dispose();

    this.stateMean = predictedMean;
    this.stateCov = predictedCov;
  }

  /**
   * Update step with a new measurement.
   * @param measurement Observed scalar value.
   */
  private update(measurement: number): void {
    const H = tf.tensor2d([[1, 0]]); // shape [1,2]
    const Ht = tf.transpose(H); // shape [2,1]

    // Innovation covariance: S = H * Σ * H^T + R
    const S = tf.add(
      tf.matMul(tf.matMul(H, this.stateCov), Ht),
      this.observationNoiseCov
    );

    // Kalman gain: K = Σ * H^T * S^{-1}
    const K = tf.matMul(tf.matMul(this.stateCov, Ht), tf.linalg.inv(S));

    // Innovation: y = z - H * μ
    const z = tf.scalar(measurement);
    const y = tf.sub(z, tf.matMul(H, this.stateMean.reshape([2, 1])).reshape([1]));

    // Updated state: μ = μ + K * y
    const updatedMean = tf.add(this.stateMean, tf.squeeze(tf.matMul(K, y.reshape([1, 1]))));

    // Updated covariance: Σ = (I - K * H) * Σ
    const I = tf.eye(2);
    const KH = tf.matMul(K, H);
    const updatedCov = tf.matMul(tf.sub(I, KH), this.stateCov);

    this.stateMean.dispose();
    this.stateCov.dispose();
    K.dispose();
    S.dispose();
    H.dispose();
    Ht.dispose();
    z.dispose();
    y.dispose();
    KH.dispose();
    I.dispose();

    this.stateMean = updatedMean;
    this.stateCov = updatedCov;
  }

  /**
   * Process a new metric observation.
   * @param metric Incoming metric.
   */
  public step(metric: Metric): void {
    if (typeof metric.timestamp !== 'number' || typeof metric.value !== 'number') {
      throw new Error('Invalid metric: timestamp and value must be numbers.');
    }
    if (this.lastTimestamp !== null && metric.timestamp < this.lastTimestamp) {
      throw new Error('Metric timestamps must be non‑decreasing.');
    }

    const deltaT = this.lastTimestamp === null
      ? 0
      : (metric.timestamp - this.lastTimestamp) / 1000; // convert ms to s

    if (deltaT > 0) {
      this.predict(deltaT);
    }
    this.update(metric.value);
    this.lastTimestamp = metric.timestamp;
  }

  /**
   * Get the current predicted position (mean) and its variance.
   */
  public getPrediction(): { mean: number; variance: number } {
    const mean = this.stateMean.arraySync()[0];
    const variance = this.stateCov.arraySync()[0][0];
    return { mean, variance };
  }

  /**
   * Clean up tensors to avoid memory leaks.
   */
  public dispose(): void {
    this.stateMean.dispose();
    this.stateCov.dispose();
    this.processNoiseCov.dispose();
    this.observationNoiseCov.dispose();
  }
}

/**
 * Bayesian anomaly scorer.
 *
 * Prior: P(anomaly) = priorAnomalyProb
 * Likelihood: assume residual ~ N(0, sigma^2). Anomaly likelihood is higher for large residuals.
 *
 * Posterior: P(anomaly | residual) = (L_anom * prior) / (L_anom * prior + L_norm * (1 - prior))
 */
class BayesianAnomalyScorer {
  private priorAnomalyProb: number;
  private readonly sigma: number; // standard deviation of normal residuals

  constructor(priorAnomalyProb: number = 0.01, sigma: number = 1.0) {
    if (priorAnomalyProb <= 0 || priorAnomalyProb >= 1) {
      throw new Error('priorAnomalyProb must be in (0,1).');
    }
    if (sigma <= 0) {
      throw new Error('sigma must be positive.');
    }
    this.priorAnomalyProb = priorAnomalyProb;
    this.sigma = sigma;
  }

  /**
   * Compute posterior anomaly probability given residual.
   * @param residual Difference between observed and predicted value.
   */
  public computePosterior(residual: number): number {
    // Normal likelihood: N(0, sigma^2)
    const normalLikelihood = (1 / (Math.sqrt(2 * Math.PI) * this.sigma)) *
      Math.exp(-0.5 * (residual * residual) / (this.sigma * this.sigma));

    // Anomaly likelihood: use a heavy‑tailed distribution (e.g., Laplace) as proxy
    const b = this.sigma; // scale parameter
    const anomalyLikelihood = (1 / (2 * b)) * Math.exp(-Math