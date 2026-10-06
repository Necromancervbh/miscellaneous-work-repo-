import express, { Request, Response, NextFunction, Router } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { RateLimiterTokenBucket } from 'rate-limiter-flexible';
import axios, { AxiosResponse } from 'axios';
import { Queue, QueueScheduler, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { URL } from 'url';

// ---------- Configuration ----------
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';
const FORECAST_SERVICE_URL = process.env.FORECAST_SERVICE_URL || 'http://localhost:3001';
const ANALYTICS_SERVICE_URL = process.env.ANALYTICS_SERVICE_URL || 'http://localhost:3002';
const ALERT_SERVICE_URL = process.env.ALERT_SERVICE_URL || 'http://localhost:3003';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Token Bucket parameters (per IP)
const TOKEN_BUCKET_POINTS = Number(process.env.TOKEN_BUCKET_POINTS) || 10; // max tokens
const TOKEN_BUCKET_DURATION = Number(process.env.TOKEN_BUCKET_DURATION) || 60; // seconds
const TOKEN_BUCKET_REFILL_RATE = Number(process.env.TOKEN_BUCKET_REFILL_RATE) || 10; // tokens per duration

// ---------- Types ----------
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload | string;
    }
  }
}

// ---------- JWT Validation Middleware ----------
function jwtAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    res.status(401).json({ error: 'Authorization header missing' });
    return;
  }

  const tokenMatch = authHeader.match(/^Bearer (.+)$/);
  if (!tokenMatch) {
    res.status(401).json({ error: 'Invalid Authorization format' });
    return;
  }

  const token = tokenMatch[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded as JwtPayload;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ---------- Token Bucket Rate Limiter Middleware ----------
const rateLimiter = new RateLimiterTokenBucket({
  // Token bucket formula: tokens = maxTokens - consumed + (elapsed / duration) * refillRate
  // where refillRate = maxTokens / duration
  tokenLimit: TOKEN_BUCKET_POINTS,
  duration: TOKEN_BUCKET_DURATION,
  refillRate: TOKEN_BUCKET_REFILL_RATE,
  keyPrefix: 'rlflx',
});

async function tokenBucketLimiter(req: Request, res: Response, next: NextFunction): Promise<void> {
  const key = req.ip; // could also use user id if authenticated
  try {
    await rateLimiter.consume(key, 1);
    next();
  } catch (rlRejected) {
    res.status(429).json({ error: 'Too many requests - rate limit exceeded' });
  }
}

// ---------- Helper: Proxy Request ----------
interface ProxyOptions {
  target: string;
  pathRewrite?: (originalPath: string) => string;
}

async function proxyRequest(req: Request, res: Response, options: ProxyOptions): Promise<void> {
  const targetUrl = new URL(options.target);
  const rewrittenPath = options.pathRewrite ? options.pathRewrite(req.path) : req.path;
  targetUrl.pathname = `${targetUrl.pathname.replace(/\/$/, '')}${rewrittenPath}`;
  targetUrl.search = req.url.split('?')[1] || '';

  const axiosConfig = {
    method: req.method as any,
    url: targetUrl.toString(),
    headers: { ...req.headers, host: targetUrl.host },
    data: req.body,
    params: req.query,
    responseType: 'stream' as const,
    validateStatus: () => true, // forward all status codes
  };

  try {
    const response: AxiosResponse = await axios(axiosConfig);
    res.status(response.status);
    // Forward headers (except hop-by-hop headers)
    Object.entries(response.headers).forEach(([key, value]) => {
      if (key.toLowerCase() === 'transfer-encoding') return;
      res.setHeader(key, value as string);
    });
    response.data.pipe(res);
  } catch (error) {
    const err = error as any;
    const status = err.response?.status || 502;
    const message = err.response?.data || 'Bad Gateway';
    res.status(status).json({ error: message });
  }
}

// ---------- BullMQ Queue Setup ----------
const redisConnection = new IORedis(REDIS_URL);
const jobQueue = new Queue('longRunningJobs', { connection: redisConnection });
new QueueScheduler('longRunningJobs', { connection: redisConnection }); // ensures delayed jobs are processed

// Optional: Worker example (can be moved to separate service)
new Worker(
  'longRunningJobs',
  async (job: Job) => {
    // Placeholder processing logic
    console.log(`Processing job ${job.id} of type ${job.name}`);
    // Simulate work
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return { result: 'completed' };
  },
  { connection: redisConnection }
);

// ---------- Router ----------
const router: Router = express.Router();

// Apply middlewares globally to the router
router.use(express.json()); // parse JSON bodies
router.use(jwtAuth);
router.use(tokenBucketLimiter);

// Forecast Service
router.all('/forecast/*', async (req: Request, res: Response) => {
  await proxyRequest(req, res, { target: FORECAST_SERVICE_URL });
});

// Analytics Service
router.all('/analytics/*', async (req: Request, res: Response) => {
  await proxyRequest(req, res, { target: ANALYTICS_SERVICE_URL });
});

// Alert Service
router.all('/alert/*', async (req: Request, res: Response) => {
  await proxyRequest(req, res, { target: ALERT_SERVICE_URL });
});

// Enqueue Long‑Running Job
router.post('/jobs', async (req: Request, res: Response) => {
  const { jobType, payload } = req.body;

  if (typeof jobType !== 'string' || jobType.trim() === '') {
    res.status(400).json({ error: 'jobType must be a non‑empty string' });
    return;
  }

  if (payload === undefined) {
    res.status(400).json({ error: 'payload is required' });
    return;
  }

  try {
    const job = await jobQueue.add(jobType, payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
    res.status(202).json({ jobId: job.id, status: 'queued' });
  } catch (err) {
    console.error('Failed to enqueue job:', err);
    res.status(500).json({ error: 'Failed to enqueue job' });
  }
});

// Global error handler for the router
router.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error in API Gateway:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

export default router;