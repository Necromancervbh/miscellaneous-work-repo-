import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import { Server as WebSocketServer, WebSocket } from 'ws';
import rateLimit from 'express-rate-limit';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { Queue, Worker, QueueScheduler, Job } from 'bullmq';
import IORedis from 'ioredis';
import LRUCache from 'lru-cache';
import { body, validationResult } from 'express-validator';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const {
  PORT = '3000',
  JWT_SECRET = 'change_this_secret',
  REDIS_URL = 'redis://localhost:6379',
  RATE_LIMIT_WINDOW_MS = '60000',
  RATE_LIMIT_MAX = '100',
  LRU_MAX_ITEMS = '1000',
  LRU_MAX_AGE_MS = '3600000', // 1 hour
} = process.env;

// Initialize Redis connection
const redisConnection = new IORedis(REDIS_URL);

// Initialize BullMQ components
const queueName = 'anomaly-orchestrator-queue';
const queue = new Queue(queueName, { connection: redisConnection });
const queueScheduler = new QueueScheduler(queueName, { connection: redisConnection });

// LRU Cache for results
const resultCache = new LRUCache<string, any>({
  max: Number(LRU_MAX_ITEMS),
  ttl: Number(LRU_MAX_AGE_MS),
});

// WebSocket subscription management
type SubscriptionMap = Map<string, Set<WebSocket>>; // jobId -> Set of sockets
const subscriptions: SubscriptionMap = new Map();

// Import service modules (assumed to be present in the project)
import { graphAnalysis } from './graphAnalysis';
import { forecastService } from './forecastService';
import { explainabilityService } from './explainabilityService';

// Express app setup
const app = express();
app.use(express.json());

// Rate limiter middleware
const apiLimiter = rateLimit({
  windowMs: Number(RATE_LIMIT_WINDOW_MS),
  max: Number(RATE_LIMIT_MAX),
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(apiLimiter);

// JWT authentication middleware
interface AuthenticatedRequest extends Request {
  user?: string | JwtPayload;
}
function authenticateJWT(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Input validation chain for job submission
const jobValidation = [
  body('payload')
    .isObject()
    .withMessage('payload must be an object')
    .custom((value) => {
      // Example: ensure required fields exist
      if (!value?.data) {
        throw new Error('payload must contain a data field');
      }
      return true;
    }),
];

// Route: Submit a new analysis job
app.post(
  '/jobs',
  authenticateJWT,
  jobValidation,
  async (req: AuthenticatedRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const jobId = uuidv4();
    const payload = req.body.payload;

    try {
      await queue.add(
        jobId,
        { payload, jobId },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );

      // Initial broadcast: job queued
      broadcastStatus(jobId, { status: 'queued' });

      return res.status(202).json({ jobId });
    } catch (err) {
      console.error('Failed to enqueue job:', err);
      return res.status(500).json({ error: 'Failed to enqueue job' });
    }
  },
);

// Route: Retrieve job result (from cache)
app.get('/jobs/:jobId/result', authenticateJWT, async (req: AuthenticatedRequest, res: Response) => {
  const { jobId } = req.params;
  if (!jobId) {
    return res.status(400).json({ error: 'Missing jobId parameter' });
  }

  const cached = resultCache.get(jobId);
  if (!cached) {
    return res.status(404).json({ error: 'Result not found or not yet computed' });
  }

  return res.json({ jobId, result: cached });
});

// Helper: Broadcast status updates to subscribed WebSocket clients
function broadcastStatus(jobId: string, message: any) {
  const clients = subscriptions.get(jobId);
  if (!clients) return;
  const payload = JSON.stringify({ jobId, ...message });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

// BullMQ worker to process jobs
const worker = new Worker(
  queueName,
  async (job: Job) => {
    const { payload, jobId } = job.data as { payload: any; jobId: string };
    try {
      broadcastStatus(jobId, { status: 'processing' });

      // 1. Graph analysis
      // Formula: G = f(data) where f is the graph analysis algorithm
      const graphResult = await graphAnalysis(payload);

      // 2. Forecast service
      // Formula: F = g(G) where g forecasts based on graph result
      const forecastResult = await forecastService(graphResult);

      // 3. Explainability service
      // Formula: E = h(F) where h provides explanations for forecast
      const explainabilityResult = await explainabilityService(forecastResult);

      const combinedResult = {
        graphResult,
        forecastResult,
        explainabilityResult,
      };

      // Store in LRU cache
      resultCache.set(jobId, combinedResult);

      // Broadcast completion
      broadcastStatus(jobId, { status: 'completed', result: combinedResult });

      return combinedResult;
    } catch (err) {
      console.error(`Job ${jobId} failed:`, err);
      broadcastStatus(jobId, { status: 'failed', error: (err as Error).message });
      throw err;
    }
  },
  { connection: redisConnection },
);

worker.on('failed', (job, err) => {
  if (job) {
    broadcastStatus(job.id as string, { status: 'failed', error: err.message });
  }
});

// HTTP server and WebSocket server setup
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws: WebSocket) => {
  // Expect a subscription message: { type: 'subscribe', jobId: '...' }
  ws.on('message', (data: WebSocket.Data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'subscribe' && typeof msg.jobId === 'string') {
        const { jobId } = msg;
        if (!subscriptions.has(jobId)) {
          subscriptions.set(jobId, new Set());
        }
        subscriptions.get(jobId)!.add(ws);

        // Optionally send current status if cached
        if (resultCache.has(jobId)) {
          ws.send(
            JSON.stringify