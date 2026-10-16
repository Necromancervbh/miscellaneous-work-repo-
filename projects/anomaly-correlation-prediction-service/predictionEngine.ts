import express, { Request, Response, NextFunction, Router } from 'express';
import rateLimit from 'express-rate-limit';
import LRUCache from 'lru-cache';
import crypto from 'crypto';

/**
 * KalmanFilter implements a simple 1‑D linear Kalman filter.
 *
 * State equation:
 *   x_k = x_{k-1} + w_k,   w_k ~ N(0, Q)   (process noise)
 *
 * Measurement equation:
 *   z_k = x_k + v_k,       v_k ~ N(0, R)   (measurement noise)
 *
 * The filter maintains:
 *   - x̂_k : posterior state estimate
 *   - P_k : posterior estimate covariance
 *
 * Predict step:
 *   x̂_{k|k-1} = x̂_{k-1}
 *   P_{k|k-1} = P_{k-1} + Q
 *
 * Update step:
 *   K_k = P_{k|k-1} / (P_{k|k-1} + R)
 *   x̂_k = x̂_{k|k-1} + K_k * (z_k - x̂_{k|k-1})
 *   P_k = (1 - K_k) * P_{k|k-1}
 */
export class KalmanFilter {
  private stateEstimate: number;
  private estimateCovariance: number;
  private readonly processVariance: number;
  private readonly measurementVariance: number;

  /**
   * @param initialState Initial estimate of the state (x̂_0)
   * @param initialCovariance Initial estimate covariance (P_0)
   * @param processVariance Process noise variance (Q)
   * @param measurementVariance Measurement noise variance (R)
   */
  constructor(
    initialState: number,
    initialCovariance: number,
    processVariance: number,
    measurementVariance: number
  ) {
    if (processVariance <= 0 || measurementVariance <= 0) {
      throw new Error('Process and measurement variances must be positive numbers.');
    }
    this.stateEstimate = initialState;
    this.estimateCovariance = initialCovariance;
    this.processVariance = processVariance;
    this.measurementVariance = measurementVariance;
  }

  /**
   * Predicts the next state without a new measurement.
   * For a 1‑D constant‑velocity model, the prediction is identity.
   */
  predict(): void {
    // x̂_{k|k-1} = x̂_{k-1}
    // P_{k|k-1} = P_{k-1} + Q
    this.estimateCovariance += this.processVariance;
  }

  /**
   * Incorporates a new measurement into the filter.
   * @param measurement Observed value (z_k)
   */
  update(measurement: number): void {
    // Compute Kalman gain: K_k = P_{k|k-1} / (P_{k|k-1} + R)
    const kalmanGain = this.estimateCovariance / (this.estimateCovariance + this.measurementVariance);

    // Update state estimate: x̂_k = x̂_{k|k-1} + K_k * (z_k - x̂_{k|k-1})
    this.stateEstimate = this.stateEstimate + kalmanGain * (measurement - this.stateEstimate);

    // Update covariance: P_k = (1 - K_k) * P_{k|k-1}
    this.estimateCovariance = (1 - kalmanGain) * this.estimateCovariance;
  }

  /** Returns the current posterior state estimate. */
  getState(): number {
    return this.stateEstimate;
  }

  /** Returns the current posterior estimate covariance. */
  getCovariance(): number {
    return this.estimateCovariance;
  }
}

/**
 * BayesianForecast provides a simple Gaussian forecast based on the
 * posterior from a Kalman filter. Assuming the process model remains
 * unchanged, the forecast for a future horizon h (in hours) is:
 *
 *   μ_h = μ_0                         (mean stays the same)
 *   σ²_h = σ²_0 + h * Q               (variance grows linearly with process noise)
 *
 * @param mean Current posterior mean (μ_0)
 * @param variance Current posterior variance (σ²_0)
 * @param horizonHours Forecast horizon in hours (h)
 * @param processVariance Process noise variance per hour (Q)
 */
export function gaussianForecast(
  mean: number,
  variance: number,
  horizonHours: number,
  processVariance: number
): { mean: number; variance: number } {
  if (horizonHours < 0) {
    throw new Error('Forecast horizon must be non‑negative.');
  }
  const forecastMean = mean; // unchanged for a random walk
  const forecastVariance = variance + horizonHours * processVariance;
  return { mean: forecastMean, variance: forecastVariance };
}

/* ---------- LRU Cache Setup ---------- */
const predictionCache = new LRUCache<string, { mean: number; variance: number }>({
  max: 500, // maximum 500 cached entries
  ttl: 1000 * 60 * 10, // 10 minutes TTL
});

/* ---------- Rate Limiting Middleware ---------- */
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  max: 30, // limit each IP to 30 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

/* ---------- Express Router ---------- */
const router: Router = express.Router();

/**
 * Helper to compute a deterministic cache key from request payload.
 */
function computeCacheKey(payload: unknown): string {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(payload));
  return hash.digest('hex');
}

/**
 * Async endpoint that receives anomaly scores, smooths them with a Kalman filter,
 * and returns a Bayesian forecast for the next hour.
 *
 * Expected JSON body:
 * {
 *   "scores": [number, number, ...],
 *   "processVariance": number (optional, default 1e-3),
 *   "measurementVariance": number (optional, default 1e-2)
 * }
 */
router.post(
  '/forecast',
  limiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Input validation
      if (!req.is('application/json')) {
        res.status(415).json({ error: 'Content-Type must be application/json' });
        return;
      }

      const { scores, processVariance = 1e-3, measurementVariance = 1e-2 } = req.body ?? {};

      if (!Array.isArray(scores) || scores.length === 0) {
        res