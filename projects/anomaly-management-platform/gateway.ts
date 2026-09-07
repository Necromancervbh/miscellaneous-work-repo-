import express, { Request, Response, NextFunction, Router } from 'express';
import bodyParser from 'body-parser';
import jwt, { JwtPayload } from 'jsonwebtoken';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import LRUCache from 'lru-cache';
import { EventEmitter } from 'events';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import { promisify } from 'util';
import { randomUUID } from 'crypto';

/**
 * Configuration interface – loaded from environment variables.
 */
interface Config {
  JWT_SECRET: string;
  DETECTION_SERVICE_URL: string;
  EXPLAINABILITY_SERVICE_URL: string;
  DASHBOARD_SERVICE_URL: string;
  RATE_LIMIT_CAPACITY: number; // max tokens per window
  RATE_LIMIT_REFILL_RATE: number; // tokens per second
  CACHE_MAX_ITEMS: number; // max entries in LRU cache
  CACHE_MAX_AGE_MS: number; // max age of cached items
}

/**
 * Load and validate configuration.
 */
function loadConfig(): Config {
  const required = [
    'JWT_SECRET',
    'DETECTION_SERVICE_URL',
    'EXPLAINABILITY_SERVICE_URL',
    'DASHBOARD_SERVICE_URL',
  ] as const;

  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }

  const cfg: Config = {
    JWT_SECRET: process.env.JWT_SECRET as string,
    DETECTION_SERVICE_URL: process.env.DETECTION_SERVICE_URL as string,
    EXPLAINABILITY_SERVICE_URL: process.env.EXPLAINABILITY_SERVICE_URL as string,
    DASHBOARD_SERVICE_URL: process.env.DASHBOARD_SERVICE_URL as string,
    RATE_LIMIT_CAPACITY: Number(process.env.RATE_LIMIT_CAPACITY) || 60,
    RATE_LIMIT_REFILL_RATE: Number(process.env.RATE_LIMIT_REFILL_RATE) || 1,
    CACHE_MAX_ITEMS: Number(process.env.CACHE_MAX_ITEMS) || 500,
    CACHE_MAX_AGE_MS: Number(process.env.CACHE_MAX_AGE_MS) || 5 * 60 * 1000,
  };

  if (isNaN(cfg.RATE_LIMIT_CAPACITY) || cfg.RATE_LIMIT_CAPACITY <= 0) {
    throw new Error('RATE_LIMIT_CAPACITY must be a positive number');
  }
  if (isNaN(cfg.RATE_LIMIT_REFILL_RATE) || cfg.RATE_LIMIT_REFILL_RATE <= 0) {
    throw new Error('RATE_LIMIT_REFILL_RATE must be a positive number');
  }
  if (isNaN(cfg.CACHE_MAX_ITEMS) || cfg.CACHE_MAX_ITEMS <= 0) {
    throw new Error('CACHE_MAX_ITEMS must be a positive number');
  }
  if (isNaN(cfg.CACHE_MAX_AGE_MS) || cfg.CACHE_MAX_AGE_MS <= 0) {
    throw new Error('CACHE_MAX_AGE_MS must be a positive number');
  }

  return cfg;
}

const config = loadConfig();

/**
 * Token bucket rate limiter per user.
 *
 * Formula:
 *   tokens = min(capacity, tokens + (now - lastRefill) * refillRate)
 *   if tokens >= 1 -> allow request and decrement token.
 */
class TokenBucket {
  private capacity: number;
  private refillRate: number; // tokens per second
  private tokens: number;
  private lastRefill: number; // epoch ms

  constructor(capacity: number, refillRate: number) {
    this.capacity = capacity;
    this.refillRate = refillRate;
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    const added = elapsedSec * this.refillRate;
    this.tokens = Math.min(this.capacity, this.tokens + added);
    this.lastRefill = now;
  }

  public tryRemoveToken(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

/**
 * Per‑user rate limiter manager.
 */
class RateLimiter {
  private buckets: Map<string, TokenBucket> = new Map();

  constructor(private capacity: number, private refillRate: number) {}

  public isAllowed(userId: string): boolean {
    let bucket = this.buckets.get(userId);
    if (!bucket) {
      bucket = new TokenBucket(this.capacity, this.refillRate);
      this.buckets.set(userId, bucket);
    }
    return bucket.tryRemoveToken();
  }
}

/**
 * Simple in‑memory job queue with EventEmitter.
 * Jobs are processed asynchronously; in production replace with BullMQ/Redis.
 */
interface Job {
  id: string;
  type: string;
  payload: any;
  createdAt: number;
}

class JobQueue extends EventEmitter {
  private queue: Job[] = [];
  private processing = false;

  public enqueue(job: Job): void {
    this.queue.push(job);
    this.emit('enqueued', job);
    this.processNext();
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) {
      return;
    }
    this.processing = true;
    const job = this.queue.shift() as Job;
    try {
      // Simulate async processing – replace with real logic.
      await new Promise((resolve) => setTimeout(resolve, 100));
      this.emit('completed', job);
    } catch (err) {
      this.emit('failed', job, err);
    } finally {
      this.processing = false;
      // Continue processing remaining jobs.
      this.processNext();
    }
  }
}

/**
 * LRU cache for recent anomaly scores.
 * Key: string (e.g., anomaly ID)
 * Value: any (score object)
 */
const anomalyCache = new LRUCache<string, any>({
  max: config.CACHE_MAX_ITEMS,
  ttl: config.CACHE_MAX_AGE_MS,
});

/**
 * Axios instances for downstream services with keep‑alive agents.
 */
function createAxiosInstance(baseURL: string): AxiosInstance {
  const url = new URL(baseURL);
  const isHttps = url.protocol === 'https:';
  const agent = isHttps
    ? new https.Agent({ keepAlive: true })
    : new http.Agent({ keepAlive: true });

  return axios.create({
    baseURL,
    timeout: 10_000,
    httpAgent: agent,
    httpsAgent: agent,
  });
}

const detectionClient = createAxiosInstance(config.DETECTION_SERVICE_URL);
const explainabilityClient = createAxiosInstance(config.EXPLAINABILITY_SERVICE_URL);
const dashboardClient = createAxiosInstance(config.DASHBOARD_SERVICE_URL);

/**
 * Express middleware for JWT authentication.
 * Attaches decoded payload to req.user.
 */
function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, config.JWT_SECRET) as JwtPayload;
    if (!payload.sub) {
      throw new Error('JWT missing subject (sub) claim');
    }
    // Attach user identifier (subject) to request.
    (req as any).user = { id: payload.sub };
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token', details: (err as Error).message });
  }
}

/**
 * Rate‑limit middleware – per user.
 */
const rateLimiter = new RateLimiter(config.RATE_LIMIT_CAPACITY, config.RATE_LIMIT_REFILL_RATE);
function rateLimitMiddleware(req: