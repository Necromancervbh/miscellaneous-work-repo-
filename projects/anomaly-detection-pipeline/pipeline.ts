import { Readable } from 'stream';
import { Queue, QueueScheduler, Worker, Job, QueueEvents, QueueOptions } from 'bullmq';
import * as jwt from 'jsonwebtoken';
import { Server as WebSocketServer, WebSocket } from 'ws';
import { DBSCAN } from 'density-clustering';
import { createHash } from 'crypto';
import { setTimeout } from 'timers/promises';

/**
 * Simple Kalman filter for 1‑D data.
 * The filter estimates the true value x̂ given noisy observations z.
 *
 * Equations:
 *   Predict:   x̂ₖ|ₖ₋₁ = x̂ₖ₋₁
 *              Pₖ|ₖ₋₁ = Pₖ₋₁ + Q
 *   Update:   Kₖ = Pₖ|ₖ₋₁ / (Pₖ|ₖ₋₁ + R)
 *              x̂ₖ = x̂ₖ|ₖ₋₁ + Kₖ (zₖ - x̂ₖ|ₖ₋₁)
 *              Pₖ = (1 - Kₖ) Pₖ|ₖ₋₁
 */
class SimpleKalmanFilter {
  private estimate: number;
  private errorCovariance: number;
  private readonly processVariance: number;
  private readonly measurementVariance: number;

  constructor(initialEstimate: number, processVariance = 1e-5, measurementVariance = 0.01) {
    this.estimate = initialEstimate;
    this.errorCovariance = 1;
    this.processVariance = processVariance;
    this.measurementVariance = measurementVariance;
  }

  public filter(measurement: number): number {
    // Predict
    const priorEstimate = this.estimate;
    const priorErrorCov = this.errorCovariance + this.processVariance;

    // Update
    const kalmanGain = priorErrorCov / (priorErrorCov + this.measurementVariance);
    this.estimate = priorEstimate + kalmanGain * (measurement - priorEstimate);
    this.errorCovariance = (1 - kalmanGain) * priorErrorCov;

    return this.estimate;
  }
}

/**
 * Rate limiter based on token bucket algorithm.
 * Each user (identified by JWT sub claim) gets a configurable number of tokens per interval.
 */
class JwtRateLimiter {
  private readonly maxTokens: number;
  private readonly refillIntervalMs: number;
  private readonly tokensMap: Map<string, { tokens: number; lastRefill: number }>;

  constructor(maxTokens = 100, refillIntervalMs = 60_000) {
    this.maxTokens = maxTokens;
    this.refillIntervalMs = refillIntervalMs;
    this.tokensMap = new Map();
  }

  private refill(userId: string): void {
    const now = Date.now();
    const bucket = this.tokensMap.get(userId);
    if (!bucket) {
      this.tokensMap.set(userId, { tokens: this.maxTokens, lastRefill: now });
      return;
    }
    const elapsed = now - bucket.lastRefill;
    if (elapsed >= this.refillIntervalMs) {
      const refillCount = Math.floor(elapsed / this.refillIntervalMs);
      bucket.tokens = Math.min(this.maxTokens, bucket.tokens + refillCount * this.maxTokens);
      bucket.lastRefill = now;
    }
  }

  public isAllowed(userId: string): boolean {
    this.refill(userId);
    const bucket = this.tokensMap.get(userId)!;
    if (bucket.tokens > 0) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }
}

/**
 * Types
 */
interface RawMetric {
  timestamp: number; // epoch ms
  value: number;
  token: string; // JWT token
  [key: string]: any;
}

interface ProcessedMetric {
  timestamp: number;
  value: number;
  smoothed: number;
  residual: number;
  outlier: boolean;
  clusterId?: number;
}

/**
 * Main pipeline class
 */
export class RealTimeAnomalyPipeline {
  private readonly metricStream: Readable;
  private readonly wsServer: WebSocketServer;
  private readonly jwtSecret: string;
  private readonly queue: Queue<ProcessedMetric>;
  private readonly rateLimiter: JwtRateLimiter;
  private readonly dbscan: DBSCAN;
  private readonly kalmanFilters: Map<string, SimpleKalmanFilter>;

  constructor(params: {
    metricStream: Readable;
    wsServer: WebSocketServer;
    jwtSecret: string;
    redisConnection: QueueOptions['connection'];
    maxTokensPerMinute?: number;
  }) {
    const { metricStream, wsServer, jwtSecret, redisConnection, maxTokensPerMinute } = params;
    this.metricStream = metricStream;
    this.wsServer = wsServer;
    this.jwtSecret = jwtSecret;

    this.queue = new Queue<ProcessedMetric>('anomaly-results', { connection: redisConnection });
    new QueueScheduler('anomaly-results', { connection: redisConnection });

    this.rateLimiter = new JwtRateLimiter(maxTokensPerMinute ?? 100, 60_000);
    this.dbscan = new DBSCAN();
    this.kalmanFilters = new Map();

    // Worker to process queued jobs (optional: could be used for further async handling)
    new Worker<ProcessedMetric>('anomaly-results', async (job) => {
      // Placeholder for additional background processing if needed.
      return job.data;
    }, { connection: redisConnection });
  }

  /**
   * Starts the pipeline processing.
   */
  public async start(): Promise<void> {
    for await (const chunk of this.metricStream) {
      try {
        const rawMetric = this.parse