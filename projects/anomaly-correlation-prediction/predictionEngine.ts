import { verifyJwt } from './auth/jwtVerifier';
import { RateLimiter } from './rateLimiter';
import { Cache } from './cache';
import { Request, Response, NextFunction } from 'express';
import * as tf from '@tensorflow/tfjs-node';

/**
 * KalmanFilter implements a simple 1‑dimensional Kalman filter.
 *
 * State equations:
 *   x_k   = x_{k-1} + w_k          (process model)
 *   z_k   = x_k + v_k              (measurement model)
 *
 * where w_k ~ N(0, Q) is process noise and v_k ~ N(0, R) is measurement noise.
 *
 * Prediction step:
 *   x̂_k|k-1 = x̂_{k-1}|k-1
 *   P_k|k-1 = P_{k-1}|k-1 + Q
 *
 * Update step:
 *   K_k = P_k|k-1 / (P_k|k-1 + R)
 *   x̂_k|k = x̂_k|k-1 + K_k (z_k - x̂_k|k-1)
 *   P_k|k = (1 - K_k) P_k|k-1
 */
class KalmanFilter {
  private state: number; // x̂_k|k
  private covariance: number; // P_k|k
  private readonly processNoise: number; // Q
  private readonly measurementNoise: number; // R

  constructor(initialState = 0, initialCovariance = 1, processNoise = 1e-3, measurementNoise = 1e-2) {
    this.state = initialState;
    this.covariance = initialCovariance;
    this.processNoise = processNoise;
    this.measurementNoise = measurementNoise;
  }

  /**
   * Predicts the next state (1‑step ahead) without incorporating a new measurement.
   */
  predict(): number {
    // x̂_k|k-1 = x̂_{k-1}|k-1 (identity transition)
    this.covariance = this.covariance + this.processNoise; // P_k|k-1
    return this.state; // predicted state
  }

  /**
   * Updates the filter with a new measurement.
   * @param measurement The observed anomaly score.
   */
  update(measurement: number): void {
    // Compute Kalman gain
    const kalmanGain = this.covariance / (this.covariance + this.measurementNoise);
    // Update state estimate
    this.state = this.state + kalmanGain * (measurement - this.state);
    // Update covariance
    this.covariance = (1 - kalmanGain) * this.covariance;
  }

  /**
   * Returns the current estimated state.
   */
  getState(): number {
    return this.state;
  }
}

/**
 * PredictionEngine consumes streaming anomaly scores, maintains a Kalman filter,
 * and provides an async predict method protected by JWT auth, rate limiting,
 * and caching.
 */
export class PredictionEngine {
  private readonly kalman: KalmanFilter;
  private readonly rateLimiter: RateLimiter;
  private readonly cache: Cache;
  private readonly cacheTTLSeconds: number;

  constructor(rateLimiter: RateLimiter, cache: Cache, cacheTTLSeconds = 30) {
    this.kalman = new KalmanFilter();
    this.rateLimiter = rateLimiter;
    this.cache = cache;
    this.cacheTTLSeconds = cacheTTLSeconds;
  }

  /**
   * Ingests a new anomaly score into the Kalman filter.
   * @param score Anomaly score (must be a finite number).
   * @param timestamp Unix epoch milliseconds (optional, used for future extensions).
   */
  addScore(score: number, timestamp?: number): void {
    if (!Number.isFinite(score)) {
      throw new Error('Invalid anomaly score: must be a finite number.');
    }
    // Update filter with the new measurement.
    this.kalman.update(score);
  }

  /**
   * Produces a 1‑step ahead prediction.
   * The method validates JWT, enforces rate limiting, and caches the result.
   *
   * @param token JWT token string from the caller.
   * @returns Predicted anomaly score.
   */
  async predict(token: string): Promise<number> {
    // 1️⃣ JWT authentication
    const payload = await verifyJwt(token);
    if (!payload || typeof payload.sub !== 'string') {
      throw new Error('Authentication failed: invalid token payload.');
    }

    const userKey = `predict:${payload.sub}`;

    // 2️⃣ Rate limiting per user
    await this.rateLimiter.consume(userKey);

    // 3️⃣ Check cache
    const cached = await this.cache.get<number>(userKey);
    if (cached !== null && cached !== undefined) {
      return cached;
    }

    // 4️⃣ Compute prediction
    const prediction = this.kalman.predict();

    // 5️⃣ Store in cache
    await this.cache.set(userKey, prediction, this.cacheTTLSeconds);

    return prediction;
  }

  /**
   * Express middleware wrapper exposing the async predict method as an HTTP endpoint.
   * Expected to be used as: app.get('/predict', predictionEngine.middleware());
   */
  middleware() {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          res.status(401).json({ error: 'Missing or malformed Authorization header.' });
          return;
        }
        const token = authHeader.slice(7);
        const result = await this.predict(token);
        res.json({ prediction: result });
      } catch (err) {
        if ((err as any).message?.includes('Rate limit')) {
          res.status(429).json({ error: 'Rate limit exceeded.' });
        } else if ((err as any).message?.includes('Authentication')) {
          res.status(401).json({ error: 'Unauthorized.' });
        } else {
          console.error('PredictionEngine error:', err);
          res.status(500).json({ error: 'Internal server error.' });
        }
      }
    };
  }
}

/**
 * Example usage (to be placed in server bootstrap file):
 *
 * import express from 'express';
 * import { PredictionEngine } from './predictionEngine';
 * import { RedisCache } from './cache/redisCache';
 * import { InMemoryRateLimiter } from './rateLimiter/inMemoryRateLimiter';
 *
 * const app = express();
 * const cache = new RedisCache(); // implements Cache interface
 * const rateLimiter = new InMemoryRateLimiter({ points: 10, duration: 60 });
 * const engine = new PredictionEngine(rateLimiter, cache);
 *
 * // Endpoint to ingest scores
 * app.post('/score', express.json(), async (req, res) => {
 *   const { score, timestamp } = req.body;
 *   try {
 *     engine.addScore(score, timestamp);
 *     res.sendStatus(204);
 *   } catch (e) {
 *     res.status(400).json({ error: e.message });
 *   }
 * });
 *
 * // Prediction endpoint
 * app.get('/predict', engine.middleware());
 *
 * app.listen(3000, () => console.log('Server listening on port 3000'));
 */