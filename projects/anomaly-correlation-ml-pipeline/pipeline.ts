import express, { Request, Response, NextFunction, Router } from 'express';
import axios, { AxiosResponse } from 'axios';
import { createHash } from 'crypto';
import Redis from 'ioredis';
import jwt from 'jsonwebtoken';
import { KMeans } from 'ml-kmeans';

/**
 * Configuration interface
 */
interface PipelineConfig {
  /** URL to fetch aggregated data from */
  dataSourceUrl: string;
  /** Number of clusters for K‑Means */
  kMeansClusters: number;
  /** Redis connection options */
  redisOptions: Redis.RedisOptions;
  /** JWT secret for token verification */
  jwtSecret: string;
  /** Cache TTL in seconds */
  cacheTTL: number;
}

/**
 * Default configuration – can be overridden via environment variables
 */
const defaultConfig: PipelineConfig = {
  dataSourceUrl: process.env.DATA_SOURCE_URL || 'http://localhost:3000/aggregated',
  kMeansClusters: Number(process.env.KMEANS_CLUSTERS) || 3,
  redisOptions: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
  },
  jwtSecret: process.env.JWT_SECRET || 'change_this_secret',
  cacheTTL: Number(process.env.CACHE_TTL) || 300, // 5 minutes
};

/**
 * Simple 1‑dimensional Kalman filter implementation.
 *
 * The filter estimates the true value `x` from noisy measurements `z`.
 * Equations:
 *   Predict:   x̂ₖ₋ = x̂ₖ₋₁
 *   Predict:   Pₖ₋ = Pₖ₋₁ + Q
 *   Update:    Kₖ = Pₖ₋ / (Pₖ₋ + R)
 *   Update:    x̂ₖ = x̂ₖ₋ + Kₖ (zₖ - x̂ₖ₋)
 *   Update:    Pₖ = (1 - Kₖ) Pₖ₋
 *
 * Q – process variance, R – measurement variance.
 */
class KalmanFilter1D {
  private q: number; // process variance
  private r: number; // measurement variance
  private x: number; // estimated value
  private p: number; // estimation error covariance
  private k: number; // kalman gain

  constructor(processVariance = 1e-5, measurementVariance = 0.01, initialEstimate = 0) {
    this.q = processVariance;
    this.r = measurementVariance;
    this.x = initialEstimate;
    this.p = 1;
    this.k = 0;
  }

  /**
   * Feed a new measurement into the filter.
   * @param measurement Noisy observation
   * @returns Filtered estimate
   */
  public filter(measurement: number): number {
    // Predict
    this.p = this.p + this.q;

    // Update
    this.k = this.p / (this.p + this.r);
    this.x = this.x + this.k * (measurement - this.x);
    this.p = (1 - this.k) * this.p;

    return this.x;
  }

  /**
   * Process an array of measurements.
   * @param data Array of numbers
   * @returns Object containing filtered values and residuals
   */
  public process(data: number[]): { filtered: number[]; residuals: number[] } {
    const filtered: number[] = [];
    const residuals: number[] = [];

    for (const z of data) {
      const estimate = this.filter(z);
      filtered.push(estimate);
      residuals.push(z - estimate); // residual = observed - predicted
    }

    return { filtered, residuals };
  }
}

/**
 * Core pipeline class encapsulating all steps.
 */
class AnomalyPipeline {
  private config: PipelineConfig;
  private redisClient: Redis.Redis;

  constructor(config?: Partial<PipelineConfig>) {
    this.config = { ...defaultConfig, ...config };
    this.redisClient = new Redis(this.config.redisOptions);
    this.redisClient.on('error', (err) => console.error('Redis error:', err));
  }

  /**
   * Fetch aggregated data from the configured source.
   * Expected format: JSON array of numbers.
   */
  private async fetchAggregatedData(): Promise<number[]> {
    let response: AxiosResponse;
    try {
      response = await axios.get(this.config.dataSourceUrl, { timeout: 5000 });
    } catch (err) {
      throw new Error(`Failed to fetch data from ${this.config.dataSourceUrl}: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!Array.isArray(response.data)) {
      throw new TypeError('Aggregated data response is not an array');
    }

    const numericData = response.data.map((v, idx) => {
      const num = Number(v);
      if (Number.isNaN(num)) {
        throw new TypeError(`Data at index ${idx} is not a number`);
      }
      return num;
    });

    return numericData;
  }

  /**
   * Apply Kalman filter to the data and obtain residuals.
   */
  private applyKalman(data: number[]): { filtered: number[]; residuals: number[] } {
    const kalman = new KalmanFilter1D();
    return kalman.process(data);
  }

  /**
   * Run K‑Means clustering on residuals.
   * Returns cluster assignments and centroids.
   */
  private runKMeans(residuals: number[]): { clusters: number[]; centroids: number[][] } {
    // Convert residuals to 2‑D array required by ml‑kmeans (each point is [value])
    const points = residuals.map((r) => [r]);

    const result = KMeans(points, this.config.kMeansClusters);
    return {
      clusters: result.clusters,
      centroids: result.centroids,
    };
  }

  /**
   * Generate a deterministic cache key based on the data source URL and current date hour.
   */
  private generateCacheKey(): string {
    const now = new Date();
    const hourString = now.toISOString().slice(0, 13); // e.g., "2023-08-15T14"
    const rawKey = `${this.config.dataSourceUrl}|${hourString}`;
    return `pipeline:${createHash('sha256').update(rawKey).digest('hex')}`;
  }

  /**
   * Store pipeline result in Redis with LRU eviction policy (handled by Redis config).
   */
  private async storeInCache(key: string, value: any): Promise<void> {
    const serialized = JSON.stringify(value);
    await this.redisClient.set(key, serialized, 'EX', this.config.cacheTTL);
  }

  /**
   * Retrieve cached result if present.
   */
  private async getFromCache(key: string): Promise<any | null> {
    const raw = await this.redisClient.get(key);
    return raw ? JSON.parse(raw) : null;
  }

  /**
   * Execute the full pipeline, using cache when possible.
   */
  public async execute(): Promise<any> {
    const cacheKey = this.generateCacheKey();
    const cached = await this.getFromCache(cacheKey);
    if (cached) {
      return cached;
    }

    const data = await this.fetchAggregatedData();
    const { filtered, residuals } = this.applyKalman(data);
    const kmeansResult = this.runKMeans(residuals);

    const result = {
      timestamp: new Date().toISOString(),
      filtered,
      residuals,
      kmeans: