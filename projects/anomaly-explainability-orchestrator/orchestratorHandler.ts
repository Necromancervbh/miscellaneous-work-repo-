import { Router, Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { Queue, QueueScheduler, QueueEvents, Job } from 'bullmq';
import IORedis from 'ioredis';
import { RateLimiterRedis } from 'rate-limiter-flexible';

// ---------- Configuration ----------
const {
  JWT_SECRET = '',
  REDIS_URL = 'redis://localhost:6379',
  RATE_LIMIT_POINTS = '10', // tokens per window
  RATE_LIMIT_DURATION = '60', // window in seconds
  QUEUE_NAME = 'anomalyOrchestrator',
  JOB_TIMEOUT_MS = '30000', // 30 seconds
} = process.env;

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET environment variable is required');
}

// ---------- Redis & BullMQ Setup ----------
const redisConnection = new IORedis(REDIS_URL);

const queue = new Queue(QUEUE_NAME, {
  connection: redisConnection,
});

const queueScheduler = new QueueScheduler(QUEUE_NAME, {
  connection: redisConnection,
});

const queueEvents = new QueueEvents(QUEUE_NAME, {
  connection: redisConnection,
});

// ---------- Rate Limiter ----------
const rateLimiter = new RateLimiterRedis({
  storeClient: redisConnection,
  points: Number(RATE_LIMIT_POINTS), // number of tokens
  duration: Number(RATE_LIMIT_DURATION), // per duration in seconds
  blockDuration: Number(RATE_LIMIT_DURATION), // block for the same duration after exhaustion
});

// ---------- Types ----------
interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    [key: string]: any;
  };
}

interface AnomalyJobPayload {
  userId: string;
  data: any;
}

// ---------- Middleware ----------
function verifyJwt(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    if (!decoded.sub) {
      throw new Error('JWT missing subject');
    }
    req.user = { id: decoded.sub, ...decoded };
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid JWT', details: (err as Error).message });
  }
}

async function tokenBucketLimiter(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(400).json({ error: 'User identifier missing in request' });
    return;
  }

  try {
    await rateLimiter.consume(userId);
    next();
  } catch (rej) {
    // Rate limit exceeded
    res.status(429).json({ error: 'Too many requests', retryAfter: RATE_LIMIT_DURATION });
  }
}

// ---------- Route Handler ----------
async function orchestrateAnomalyDetection(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  // Input validation: expect JSON body with a "data" field
  if (!req.body || typeof req.body !== 'object' || req.body.data === undefined) {
    res.status(400).json({ error: 'Request body must contain a "data" field' });
    return;
  }

  const userId = req.user!.id;
  const payload: AnomalyJobPayload = {
    userId,
    data: req.body.data,
  };

  try {
    // Enqueue job
    const job = await queue.add('anomalyJob', payload, {
      removeOnComplete: true,
      removeOnFail: false,
      timeout: Number(JOB_TIMEOUT_MS),
    });

    // Wait for job completion
    const result = await job.waitUntilFinished(redisConnection, Number(JOB_TIMEOUT_MS));

    // Expected result shape:
    // {
    //   kalman: { ... },
    //   dbscan: { ... },
    //   bayesian: { ... }
    // }

    // Aggregate results
    const aggregated = {
      userId,
      kalman: result.kalman ?? null,
      dbscan: result.dbscan ?? null,
      bayesian: result.bayesian ?? null,
    };

    res.json(aggregated);
  } catch (err) {
    if (err instanceof Error && err.message.includes('Job timed out')) {
      res.status(504).json({ error: 'Job processing timed out' });
    } else {
      console.error('Orchestration error:', err);
      res.status(500).json({ error: 'Internal server error', details: (err as Error).message });
    }
  }
}

// ---------- Router ----------
const router = Router();

router.post(
  '/orchestrate',
  verifyJwt,
  tokenBucketLimiter,
  orchestrateAnomalyDetection,
);

export default router;