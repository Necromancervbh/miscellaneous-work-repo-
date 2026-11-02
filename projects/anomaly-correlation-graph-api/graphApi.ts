import express, { Request, Response, NextFunction, Router } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { Queue, QueueEvents, Job, Worker } from 'bullmq';
import LRUCache from 'lru-cache';
import { z } from 'zod';
import IORedis from 'ioredis';

// ---------- Configuration ----------
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;

// ---------- Redis Connection ----------
const redisConnection = new IORedis({
  host: REDIS_HOST,
  port: REDIS_PORT,
  password: REDIS_PASSWORD,
});

// ---------- BullMQ Queue ----------
const clusteringQueue = new Queue('clustering', { connection: redisConnection });
const clusteringQueueEvents = new QueueEvents('clustering', { connection: redisConnection });

// ---------- LRU Cache ----------
/**
 * Cache stores clustering results keyed by jobId.
 * max: maximum number of entries.
 * ttl: time‑to‑live in ms (e.g., 1 hour).
 */
const resultCache = new LRUCache<string, any>({
  max: 500,
  ttl: 1000 * 60 * 60, // 1 hour
});

// ---------- JWT Authentication Middleware ----------
function jwtAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }
  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Attach payload to request for downstream use if needed
    (req as any).user = payload;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ---------- Rate Limiting Middleware ----------
const ipRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // limit each IP to 30 requests per windowMs
  keyGenerator: (req) => req.ip,
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many requests, please try again later.' });
  },
});

// ---------- Request Validation ----------
const clusteringPayloadSchema = z.object({
  /**
   * data: array of points, each point is an array of numbers.
   * Example: [[1.2, 3.4], [5.6, 7.8]]
   */
  data: z.array(z.array(z.number())).nonempty(),
  algorithm: z.enum(['kmeans', 'dbscan']),
  /**
   * parameters: algorithm‑specific options.
   * For kmeans: { k: number, maxIter?: number }
   * For dbscan: { eps: number, minPoints: number }
   */
  parameters: z.record(z.any()).optional(),
});

// ---------- Queue Completion Listener ----------
clusteringQueueEvents.on('completed', async ({ jobId, returnvalue }) => {
  // Store the result in LRU cache; returnvalue is expected to be the clustering result.
  resultCache.set(jobId, returnvalue);
});

// Optional: handle failed jobs to avoid memory leaks
clusteringQueueEvents.on('failed', ({ jobId, failedReason }) => {
  console.error(`Clustering job ${jobId} failed:`, failedReason);
});

// ---------- Express Router ----------
const router: Router = express.Router();

router.post(
  '/cluster',
  jwtAuth,
  ipRateLimiter,
  express.json(),
  async (req: Request, res: Response) => {
    // Validate JSON payload
    const parseResult = clusteringPayloadSchema.safeParse(req.body);
    if (!parseResult.success) {
      res.status(400).json({ error: 'Invalid request payload', details: parseResult.error.format() });
      return;
    }

    const payload = parseResult.data;

    try {
      // Enqueue clustering task
      const job: Job = await clusteringQueue.add('run-clustering', payload, {
        // Job options: e.g., attempts, backoff can be configured here
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      });

      // Respond with job identifier; client can poll or retrieve result later
      res.status(202).json({ jobId: job.id });
    } catch (err) {
      console.error('Failed to enqueue clustering job:', err);
      res.status(500).json({ error: 'Failed to schedule clustering task' });
    }
  }
);

// ---------- Result Retrieval Endpoint (Optional) ----------
router.get(
  '/cluster/:jobId',
  jwtAuth,
  ipRateLimiter,
  async (req: Request, res: Response) => {
    const { jobId } = req.params;
    if (!jobId) {
      res.status(400).json({ error: 'Missing jobId parameter' });
      return;
    }

    // Check cache first
    const cachedResult = resultCache.get(jobId);
    if (cachedResult) {
      res.status(200).json({ jobId, status: 'completed', result: cachedResult });
      return;
    }

    // If not cached, query BullMQ for status
    try {
      const job = await clusteringQueue.getJob(jobId);
      if (!job) {
        res.status(404).json({ error: 'Job not found' });
        return;
      }

      const state = await job.getState();
      if (state === 'completed') {
        // Should have been cached, but fallback to job returnvalue
        const result = await job.returnvalue;
        resultCache.set(jobId, result);
        res.status(200).json({ jobId, status: 'completed', result });
      } else if (state === 'failed') {
        const failedReason = job.failedReason;
        res.status(200).json({ jobId, status: 'failed', reason: failedReason });
      } else {
        res.status(200).json({ jobId, status: state });
      }
    } catch (err) {
      console.error('Error fetching job status:', err);
      res.status(500).json({ error: 'Failed to retrieve job status' });
    }
  }
);

export default router;