import { Queue, Job, QueueScheduler, Worker } from 'bullmq';
import { CronJob } from 'cron';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { URL } from 'url';
import { setTimeout as delay } from 'timers/promises';

/**
 * Configuration interface for the SchedulerService.
 */
export interface SchedulerConfig {
  /**
   * Secret key used to verify JWT tokens.
   */
  jwtSecret: string;
  /**
   * Redis connection options for BullMQ.
   */
  redis: {
    host: string;
    port: number;
    password?: string;
    tls?: object;
  };
  /**
   * Name of the BullMQ queue where forecast tasks are enqueued.
   */
  queueName: string;
  /**
   * Maximum number of tokens a client can accumulate.
   */
  bucketCapacity: number;
  /**
   * Rate at which tokens are added to the bucket (tokens per second).
   */
  refillRate: number;
}

/**
 * Payload expected inside the JWT token.
 */
export interface JwtPayload {
  sub: string; // client identifier
  exp?: number;
  iat?: number;
}

/**
 * Represents a token bucket for rate limiting.
 *
 * The bucket holds a number of tokens up to `capacity`.
 * Tokens are refilled at a constant `refillRate` (tokens per second).
 * A request consumes one token; if none are available the request is rejected.
 */
class TokenBucket {
  private capacity: number;
  private tokens: number;
  private refillRate: number; // tokens per second
  private lastRefill: number; // timestamp in ms

  constructor(capacity: number, refillRate: number) {
    if (capacity <= 0) throw new Error('Bucket capacity must be > 0');
    if (refillRate <= 0) throw new Error('Refill rate must be > 0');
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = refillRate;
    this.lastRefill = Date.now();
  }

  /**
   * Attempt to consume a token.
   * @returns true if a token was consumed, false otherwise.
   */
  public tryConsume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /**
   * Refill tokens based on elapsed time.
   * tokens = min(capacity, tokens + elapsed * refillRate)
   */
  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    const added = elapsedSec * this.refillRate;
    this.tokens = Math.min(this.capacity, this.tokens + added);
    this.lastRefill = now;
  }
}

/**
 * SchedulerService registers cron jobs that trigger the forecast pipeline.
 * It validates JWT authentication per client, enforces a token‑bucket rate limiter,
 * and pushes jobs onto an async BullMQ queue.
 */
export class SchedulerService extends EventEmitter {
  private config: SchedulerConfig;
  private queue: Queue;
  private queueScheduler: QueueScheduler;
  private buckets: Map<string, TokenBucket>;
  private jobs: Map<string, CronJob>;

  /**
   * @param config Scheduler configuration.
   */
  constructor(config: SchedulerConfig) {
    super();
    this.validateConfig(config);
    this.config = config;
    this.queue = new Queue(this.config.queueName, { connection: this.config.redis });
    this.queueScheduler = new QueueScheduler(this.config.queueName, { connection: this.config.redis });
    this.buckets = new Map();
    this.jobs = new Map();
  }

  /**
   * Validates the supplied configuration object.
   * Throws if any required field is missing or malformed.
   */
  private validateConfig(cfg: SchedulerConfig): void {
    if (!cfg.jwtSecret || typeof cfg.jwtSecret !== 'string') {
      throw new Error('Invalid jwtSecret in SchedulerConfig');
    }
    if (!cfg.redis || typeof cfg.redis !== 'object') {
      throw new Error('Invalid redis config in SchedulerConfig');
    }
    if (!cfg.queueName || typeof cfg.queueName !== 'string') {
      throw new Error('Invalid queueName in SchedulerConfig');
    }
    if (!Number.isFinite(cfg.bucketCapacity) || cfg.bucketCapacity <= 0) {
      throw new Error('bucketCapacity must be a positive number');
    }
    if (!Number.isFinite(cfg.refillRate) || cfg.refillRate <= 0) {
      throw new Error('refillRate must be a positive number');
    }
  }

  /**
   * Registers a new cron job.
   *
   * @param jobId Unique identifier for the job (used for later removal).
   * @param cronExpression Cron expression (e.g., '0 */5 * * * *' for every 5 minutes).
   * @param clientJwt JWT token belonging to the client that owns this job.
   * @param payload Arbitrary data that will be passed to the forecast pipeline.
   *
   * @throws Error if validation fails or a job with the same ID already exists.
   */
  public async registerJob(
    jobId: string,
    cronExpression: string,
    clientJwt: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (!jobId || typeof jobId !== 'string') {
      throw new Error('jobId must be a non‑empty string');
    }
    if (this.jobs.has(jobId)) {
      throw new Error(`Job with id ${jobId} already exists`);
    }
    if (!cronExpression || typeof cronExpression !== 'string') {
      throw new Error('cronExpression must be a non‑empty string');
    }
    if (!clientJwt || typeof clientJwt !== 'string') {
      throw new Error('clientJwt must be a non‑empty string');
    }
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('payload must be a non‑null object');
    }

    const decoded = this.verifyJwt(clientJwt);
    const clientId = decoded.sub;
    if (!clientId) {
      throw new Error('JWT payload missing required "sub" (client identifier) claim');
    }

    // Ensure a token bucket exists for the client
    if (!this.buckets.has(clientId)) {
      this.buckets.set(
        clientId,
        new TokenBucket(this.config.bucketCapacity, this.config.refillRate)
      );
    }

    const job = new CronJob(cronExpression, async () => {
      try {
        await this.handleExecution(jobId, clientId, payload);
      } catch (err) {
        this.emit('error', err);
      }
    });

    job.start();
    this.jobs.set(jobId, job);
    this.emit('jobRegistered', { jobId, clientId, cronExpression });
  }

  /**
   * Removes a previously registered job.
   *
   * @param jobId Identifier of the job to remove.
   * @returns true if a job was removed, false otherwise.
   */
  public deregisterJob(jobId: string): boolean {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    job.stop();
    this.jobs.delete(jobId);
    this.emit('jobDeregistered', { jobId });
    return true;
  }

  /**
   * Gracefully shuts down the scheduler, stopping all cron jobs
   * and closing the BullMQ queue.
   */
  public async shutdown(): Promise<void> {
    for (const [, job] of this.jobs) {
      job.stop();
    }
    this.jobs.clear();
    await this.queueScheduler.close();
    await this.queue.close();
    this.emit('shutdown');
  }

  /**
   * Verifies the JWT token using the configured secret.
   *
   * @param token JWT token string.
   * @returns Decoded payload.
   * @throws Error if verification fails.
   */
  private verifyJwt(token: string): JwtPayload {
    try {
      const decoded = jwt.verify(token, this.config.jwtSecret) as JwtPayload;
      return decoded;
    } catch (err) {
      throw new Error(`JWT verification failed: ${(err as Error).message}`);
    }
  }

  /**
   * Handles a single execution of a scheduled job.