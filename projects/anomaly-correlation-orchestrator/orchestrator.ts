import cron from 'node-cron';
import Redis from 'ioredis';
import WebSocket, { Server as WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { kmeans } from 'ml-kmeans';
import { EventEmitter } from 'events';
import { createServer, IncomingMessage } from 'http';
import { URL } from 'url';

/**
 * Simple 1‑dimensional Kalman filter implementation.
 * The filter estimates the true value of a noisy measurement series.
 *
 * Equations:
 *   Predict:
 *     x̂ₖ|ₖ₋₁ = x̂ₖ₋₁|ₖ₋₁
 *     Pₖ|ₖ₋₁ = Pₖ₋₁|ₖ₋₁ + Q
 *   Update:
 *     Kₖ = Pₖ|ₖ₋₁ / (Pₖ|ₖ₋₁ + R)
 *     x̂ₖ|ₖ = x̂ₖ|ₖ₋₁ + Kₖ (zₖ - x̂ₖ|ₖ₋₁)
 *     Pₖ|ₖ = (1 - Kₖ) Pₖ|ₖ₋₁
 */
class KalmanFilter1D {
  private q: number; // process variance
  private r: number; // measurement variance
  private x: number; // estimated value
  private p: number; // estimation error covariance
  private initialized: boolean;

  constructor(q = 1e-5, r = 0.01, initialValue = 0) {
    this.q = q;
    this.r = r;
    this.x = initialValue;
    this.p = 1;
    this.initialized = false;
  }

  public filter(measurements: number[]): { forecast: number[]; residuals: number[] } {
    const forecast: number[] = [];
    const residuals: number[] = [];

    for (const z of measurements) {
      if (!this.initialized) {
        this.x = z;
        this.initialized = true;
      }

      // Predict
      const pPrior = this.p + this.q;

      // Update
      const k = pPrior / (pPrior + this.r);
      const xPost = this.x + k * (z - this.x);
      const pPost = (1 - k) * pPrior;

      const residual = z - xPost;

      forecast.push(xPost);
      residuals.push(residual);

      // Prepare for next iteration
      this.x = xPost;
      this.p = pPost;
    }

    return { forecast, residuals };
  }
}

/**
 * Rate limiter based on token bucket algorithm.
 * Allows `maxTokens` actions per `refillIntervalMs`.
 */
class RateLimiter {
  private maxTokens: number;
  private refillIntervalMs: number;
  private tokensMap: Map<string, { tokens: number; lastRefill: number }>;

  constructor(maxTokens = 5, refillIntervalMs = 1000) {
    this.maxTokens = maxTokens;
    this.refillIntervalMs = refillIntervalMs;
    this.tokensMap = new Map();
  }

  public tryConsume(key: string): boolean {
    const now = Date.now();
    const entry = this.tokensMap.get(key) ?? { tokens: this.maxTokens, lastRefill: now };
    const elapsed = now - entry.lastRefill;

    // Refill tokens proportionally to elapsed time
    const refillCount = Math.floor(elapsed / this.refillIntervalMs) * this.maxTokens;
    if (refillCount > 0) {
      entry.tokens = Math.min(this.maxTokens, entry.tokens + refillCount);
      entry.lastRefill = now;
    }

    if (entry.tokens > 0) {
      entry.tokens -= 1;
      this.tokensMap.set(key, entry);
      return true;
    }

    this.tokensMap.set(key, entry);
    return false;
  }
}

/**
 * Orchestrator coordinates forecasting, clustering, caching, alerting,
 * and streaming updates via a JWT‑protected WebSocket.
 */
export class Orchestrator extends EventEmitter {
  private redis: Redis.Redis;
  private alertEngine: { trigger: (payload: any) => Promise<void> };
  private wss: WebSocketServer | null = null;
  private jwtSecret: string;
  private rateLimiter: RateLimiter;

  constructor(
    redisUrl: string,
    alertEngine: { trigger: (payload: any) => Promise<void> },
    jwtSecret: string,
    rateLimiterOptions?: { maxTokens?: number; refillIntervalMs?: number }
  ) {
    super();

    if (!redisUrl) {
      throw new Error('Redis URL must be provided');
    }
    if (!jwtSecret) {
      throw new Error('JWT secret must be provided');
    }

    this.redis = new Redis(redisUrl);
    this.alertEngine = alertEngine;
    this.jwtSecret = jwtSecret;
    this.rateLimiter = new RateLimiter(
      rateLimiterOptions?.maxTokens ?? 5,
      rateLimiterOptions?.refillIntervalMs ?? 1000
    );
  }

  /**
   * Schedule a recurring Kalman forecast job.
   * @param cronExpression Valid cron string (e.g., '0 * * * *')
   * @param dataProvider Function returning a Promise of numeric array
   * @param k Number of clusters for K‑Means
   */
  public scheduleForecast(
    cronExpression: string,
    dataProvider: () => Promise<number[]>,
    k: number = 3
  ): void {
    if (!cron.validate(cronExpression)) {
      throw new Error(`Invalid cron expression: ${cronExpression}`);
    }
    if (typeof dataProvider !== 'function') {
      throw new Error('dataProvider must be a function returning a Promise<number[]>');
    }
    if (!Number.isInteger(k) || k <= 0) {
      throw new Error('k must be a positive integer');
    }

    cron.schedule(cronExpression, async () => {
      try {
        const rawData = await dataProvider();
        if (!Array.isArray(rawData) || rawData.some((v) => typeof v !== 'number')) {
          throw new Error('Data provider must return an array of numbers');
        }

        const { forecast, residuals } = new KalmanFilter1D().filter(rawData);
        const clusters = this.runKMeans(residuals, k);
        const cacheKey = `forecast:${Date.now()}`;
        await this.cacheResult(cacheKey, { forecast, residuals, clusters });

        await this.triggerAlertIfNeeded(clusters);
        this.broadcastUpdate({ type: 'forecast', data: { forecast, residuals, clusters } });
      } catch (err) {
        this.emit('error', err);
      }
    });
  }

  /**
   * Run K‑Means clustering on residuals.
   * @param residuals Numeric array
   * @param k Number of clusters
   */
  private runKMeans(residuals: number[], k: number) {
    // ml‑kmeans expects a 2‑D array of points
    const points = residuals.map((v) => [v]);
    const result = kmeans(points, k);
    // Transform result to a more convenient shape
    return {
      centroids: result.centroids.map((c) => c.centroid[0]),
      assignments: result.clusters,
    };
  }

  /**
   * Cache result in Redis using LRU eviction (Redis must be configured with maxmemory-policy allkeys-lru).