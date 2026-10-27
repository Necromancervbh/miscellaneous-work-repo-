import express, { Request, Response, NextFunction, Router } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { Queue, Worker, QueueScheduler, Job } from 'bullmq';
import axios, { AxiosResponse } from 'axios';
import LRUCache from 'lru-cache';
import { randomUUID } from 'crypto';
import { URL } from 'url';

// ---------- Configuration ----------
const JWT_SECRET = process.env.JWT_SECRET ?? 'your_jwt_secret';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const SERVICE_BASE_URL = process.env.SERVICE_BASE_URL ?? 'http://localhost:3000';

// Rate limiter settings (tokens per second and bucket capacity)
const RATE_LIMIT_TOKENS_PER_SEC = Number(process.env.RATE_LIMIT_TOKENS_PER_SEC) || 5;
const RATE_LIMIT_BUCKET_CAPACITY = Number(process.env.RATE_LIMIT_BUCKET_CAPACITY) || 10;

// LRU cache settings for model metadata
const MODEL_METADATA_CACHE_MAX = Number(process.env.MODEL_METADATA_CACHE_MAX) || 500;
const MODEL_METADATA_CACHE_TTL_MS = Number(process.env.MODEL_METADATA_CACHE_TTL_MS) || 5 * 60 * 1000; // 5 minutes

// ---------- Types ----------
interface AuthenticatedRequest extends Request {
  user?: { id: string; [key: string]: any };
}

// ---------- JWT Authentication Middleware ----------
function jwtAuthMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    if (!decoded.sub) {
      throw new Error('Token missing subject');
    }
    req.user = { id: decoded.sub as string, ...decoded };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token', details: (err as Error).message });
  }
}

// ---------- Token Bucket Rate Limiter ----------
class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillRate: number; // tokens per millisecond

  constructor(capacity: number, refillPerSec: number) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = refillPerSec / 1000; // convert to per ms
    this.lastRefill = Date.now();
  }

  /**
   * Attempt to consume `count` tokens.
   * @returns true if tokens were available, false otherwise.
   */
  tryRemoveTokens(count: number = 1): boolean {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  private refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const added = elapsed * this.refillRate;
    this.tokens = Math.min(this.capacity, this.tokens + added);
    this.lastRefill = now;
  }
}

// Map userId -> TokenBucket
const userBuckets = new Map<string, TokenBucket>();

function rateLimiterMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: 'User not authenticated' });
  }

  let bucket = userBuckets.get(userId);
  if (!bucket) {
    bucket = new TokenBucket(RATE_LIMIT_BUCKET_CAPACITY, RATE_LIMIT_TOKENS_PER_SEC);
    userBuckets.set(userId, bucket);
  }

  if (!bucket.tryRemoveTokens(1)) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  next();
}

// ---------- LRU Cache for Model Metadata ----------
const modelMetadataCache = new LRUCache<string, any>({
  max: MODEL_METADATA_CACHE_MAX,
  ttl: MODEL_METADATA_CACHE_TTL_MS,
});

/**
 * Retrieves model metadata, using cache when possible.
 * @param modelId Identifier of the model.
 */
async function getModelMetadata(modelId: string): Promise<any> {
  if (!modelId) {
    throw new Error('modelId is required');
  }

  const cached = modelMetadataCache.get(modelId);
  if (cached) {
    return cached;
  }

  // Placeholder: replace with actual metadata retrieval logic
  const metadata = { modelId, createdAt: new Date().toISOString() };
  modelMetadataCache.set(modelId, metadata);
  return metadata;
}

// ---------- BullMQ Queues ----------
type ServiceName = 'drift' | 'alert' | 'explainability' | 'evaluation' | 'trainer';
type ServicePayload = Record<string, any>;

interface ServiceJobData {
  userId: string;
  payload: ServicePayload;
  requestId: string;
}

// Create a scheduler for each queue to enable delayed jobs and retries
function createQueue(name: ServiceName): Queue<ServiceJobData> {
  return new Queue<ServiceJobData>(name, {
    connection: REDIS_URL,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  });
}

const driftQueue = createQueue('drift');
const alertQueue = createQueue('alert');
const explainabilityQueue = createQueue('explainability');
const evaluationQueue = createQueue('evaluation');
const trainerQueue = createQueue('trainer');

new QueueScheduler('drift', { connection: REDIS_URL });
new QueueScheduler('alert', { connection: REDIS_URL });
new QueueScheduler('explainability', { connection: REDIS_URL });
new QueueScheduler('evaluation', { connection: REDIS_URL });
new QueueScheduler('trainer', { connection: REDIS_URL });

/**
 * Generic worker that forwards the job payload to the appropriate downstream service via HTTP.
 */
function createWorker(name: ServiceName, path: string) {
  return new Worker<ServiceJobData>(name, async (job: Job<ServiceJobData>) => {
    const { userId, payload, requestId } = job.data;
    const url = new URL(path, SERVICE_BASE_URL).toString();

    try {
      const response: AxiosResponse = await axios.post(
        url,
        { ...payload, requestId, userId },
        { timeout: 10000 }
      );
      return response.data;
    } catch (err) {
      const error = err as Error;
      // Propagate error to trigger retry logic
      throw new Error(`Failed to invoke ${name} service: ${error.message}`);
    }
  }, {
    connection: REDIS_URL,
    concurrency: 5,
  });
}

// Instantiate workers for each service
createWorker('drift', '/api/drift');
createWorker('alert', '/api/alert');
createWorker('explainability', '/api/explainability');
createWorker('evaluation', '/api/evaluation');
createWorker('trainer', '/api/trainer');

// ---------- Express Router ----------
const router: Router = express.Router();

// Apply middlewares globally to the router
router.use(express.json());
router.use(jwtAuthMiddleware);
router.use(rateLimiterMiddleware);

/**
 * Helper to enqueue a job into the appropriate queue.
 */
async function enqueueJob(
  queue: Queue<ServiceJobData>,
  userId: string,
  payload: ServicePayload
): Promise<string> {
  const requestId = randomUUID();
  await queue.add('job', { userId