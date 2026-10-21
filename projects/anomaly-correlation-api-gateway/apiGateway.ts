import express, { Request, Response, NextFunction, Application } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { Queue, QueueScheduler, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import LRUCache from 'lru-cache';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { URL } from 'url';
import crypto from 'crypto';

// ---------- Configuration ----------
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const PORT = Number(process.env.PORT) || 3000;

// Rate limiter settings (tokens per interval)
const RATE_LIMIT_CAPACITY = Number(process.env.RATE_LIMIT_CAPACITY) || 100;
const RATE_LIMIT_REFILL_INTERVAL_MS = Number(process.env.RATE_LIMIT_REFILL_INTERVAL_MS) || 60_000; // 1 minute

// LRU cache settings
const CACHE_MAX_ITEMS = Number(process.env.CACHE_MAX_ITEMS) || 500;
const CACHE_MAX_AGE_MS = Number(process.env.CACHE_MAX_AGE_MS) || 5 * 60_1000; // 5 minutes

// ---------- Types ----------
interface AuthenticatedRequest extends Request {
  user?: { id: string };
}

// Token bucket per user
class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillInterval: number; // ms
  private readonly refillAmount: number;

  constructor(capacity: number, refillInterval: number) {
    this.capacity = capacity;
    this.refillInterval = refillInterval;
    this.refillAmount = capacity; // full refill each interval
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  /**
   * Attempts to consume a token.
   * @returns true if token was consumed, false otherwise.
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
   * Formula: tokens = min(capacity, tokens + (elapsed / interval) * refillAmount)
   */
  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed >= this.refillInterval) {
      const intervals = Math.floor(elapsed / this.refillInterval);
      this.tokens = Math.min(this.capacity, this.tokens + intervals * this.refillAmount);
      this.lastRefill += intervals * this.refillInterval;
    }
  }
}

// ---------- Global Instances ----------
const app: Application = express();
app.use(express.json());

// Redis connection for BullMQ
const redisConnection = new IORedis(REDIS_URL);

// BullMQ queue for heavy analytics
const analyticsQueue = new Queue('analytics', { connection: redisConnection });
new QueueScheduler('analytics', { connection: redisConnection }); // ensures delayed/retry handling

// Worker processing analytics jobs (example placeholder)
new Worker(
  'analytics',
  async (job: Job) => {
    // Simulate heavy computation
    await new Promise((res) => setTimeout(res, 2000));
    // In a real implementation, process job.data here
    return { status: 'completed', result: `Processed ${JSON.stringify(job.data)}` };
  },
  { connection: redisConnection }
);

// LRU cache for recent query results
const queryCache = new LRUCache<string, any>({
  max: CACHE_MAX_ITEMS,
  ttl: CACHE_MAX_AGE_MS,
});

// Token bucket map per userId
const tokenBuckets = new Map<string, TokenBucket>();

// ---------- Middleware ----------
function jwtAuthMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
    if (!payload.sub) {
      throw new Error('Token missing subject');
    }
    req.user = { id: payload.sub };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token', details: (err as Error).message });
  }
}

function rateLimiterMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user) {
    // Should never happen because jwtAuthMiddleware runs before
    return res.status(500).json({ error: 'User not identified for rate limiting' });
  }
  const userId = req.user.id;
  let bucket = tokenBuckets.get(userId);
  if (!bucket) {
    bucket = new TokenBucket(RATE_LIMIT_CAPACITY, RATE_LIMIT_REFILL_INTERVAL_MS);
    tokenBuckets.set(userId, bucket);
  }
  if (!bucket.tryConsume()) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }
  next();
}

// ---------- Routes ----------
app.get(
  '/data',
  jwtAuthMiddleware,
  rateLimiterMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
    const query = req.query.q;
    if (typeof query !== 'string' || query.trim() === '') {
      return res.status(400).json({ error: 'Missing or invalid query parameter "q"' });
    }

    const cacheKey = crypto.createHash('sha256').update(query).digest('hex');
    const cached = queryCache.get(cacheKey);
    if (cached) {
      return res.json({ source: 'cache', data: cached });
    }

    try {
      // Simulated data fetch – replace with real logic
      const fetchedData = { result: `Result for ${query}`, timestamp: Date.now() };
      queryCache.set(cacheKey, fetchedData);
      res.json({ source: 'origin', data: fetchedData });
    } catch (err) {
      res.status(500).json({ error: 'Failed to fetch data', details: (err as Error).message });
    }
  }
);

app.post(
  '/analytics',
  jwtAuthMiddleware,
  rateLimiterMiddleware,
  async (req: AuthenticatedRequest, res: Response) => {
    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'Invalid request body' });
    }

    try {
      const job = await analyticsQueue.add('run', { userId: req.user?.id, payload });
      res.status(202).json({ jobId: job.id, status: 'queued' });
    } catch (err) {
      res.status(500).json({ error: 'Failed to enqueue analytics job', details: (err as Error).message });
    }
  }
);

// ---------- WebSocket Hub ----------
type Subscription = {
  ws: WebSocket;
  topics: Set<string>;
};

class WebSocketHub {
  private wss: WebSocketServer;
  private subscriptions: Set<Subscription> = new Set();

  constructor(server: http.Server) {
    this.wss = new WebSocketServer({ server });
    this.wss.on('connection', (ws: WebSocket, request: http.IncomingMessage) => {
      const sub: Subscription = { ws, topics: new Set() };
      this.subscriptions.add(sub);

      ws.on('message', (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.action === 'subscribe' && typeof msg.topic === 'string') {
            sub.topics.add(msg.topic);
          } else if (msg.action === 'unsubscribe' && typeof msg.topic === 'string') {
            sub.topics.delete(msg.topic);
          } else {
            ws.send(JSON.stringify({ error: 'Invalid message format' }));
          }
        } catch {
          ws.send(JSON.stringify({ error: 'Malformed JSON' }));
        }
      });

      ws.on('close', () => {
        this.subscriptions.delete(sub);
      });
    });
  }

  /**
   * Broadcasts a