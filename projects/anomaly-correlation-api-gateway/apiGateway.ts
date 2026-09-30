import express, { Request, Response, NextFunction } from 'express';
import { json } from 'body-parser';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { body, validationResult } from 'express-validator';
import LRUCache from 'lru-cache';
import { Queue, Worker, QueueScheduler, Job } from 'bullmq';
import IORedis from 'ioredis';
import crypto from 'crypto';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const {
    PORT = '3000',
    JWT_SECRET = 'your-secret-key',
    REDIS_URL = 'redis://127.0.0.1:6379',
    CACHE_MAX_ITEMS = '500',
    CACHE_MAX_AGE_MS = '600000', // 10 minutes
    ALERT_BUCKET_CAPACITY = '10',
    ALERT_BUCKET_REFILL_RATE = '1', // tokens per second
} = process.env;

// Types
interface AuthenticatedRequest extends Request {
    user?: JwtPayload | string;
}

// JWT Authentication Middleware
function jwtAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
        return res.status(401).json({ error: 'Missing Authorization header' });
    }

    const tokenMatch = authHeader.match(/^Bearer (.+)$/);
    if (!tokenMatch) {
        return res.status(401).json({ error: 'Invalid Authorization format' });
    }

    const token = tokenMatch[1];
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.user = payload;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

// LRU Cache for recent predictions
const predictionCache = new LRUCache<string, any>({
    max: Number(CACHE_MAX_ITEMS),
    ttl: Number(CACHE_MAX_AGE_MS),
});

// Token Bucket Rate Limiter for alerts
class TokenBucket {
    private capacity: number;
    private tokens: number;
    private refillRate: number; // tokens per millisecond
    private lastRefill: number;

    constructor(capacity: number, refillPerSecond: number) {
        this.capacity = capacity;
        this.tokens = capacity;
        this.refillRate = refillPerSecond / 1000;
        this.lastRefill = Date.now();
    }

    private refill() {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        const added = elapsed * this.refillRate;
        this.tokens = Math.min(this.capacity, this.tokens + added);
        this.lastRefill = now;
    }

    public tryRemoveTokens(count: number): boolean {
        this.refill();
        if (this.tokens >= count) {
            this.tokens -= count;
            return true;
        }
        return false;
    }
}

// Map of user identifier -> TokenBucket
const alertBuckets = new Map<string, TokenBucket>();

function alertRateLimiter(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    const userId = typeof req.user === 'object' && req.user?.sub ? String(req.user.sub) : req.ip;
    let bucket = alertBuckets.get(userId);
    if (!bucket) {
        bucket = new TokenBucket(
            Number(ALERT_BUCKET_CAPACITY),
            Number(ALERT_BUCKET_REFILL_RATE)
        );
        alertBuckets.set(userId, bucket);
    }

    if (bucket.tryRemoveTokens(1)) {
        next();
    } else {
        res.status(429).json({ error: 'Rate limit exceeded for alerts' });
    }
}

// BullMQ setup
const connection = new IORedis(REDIS_URL);
const predictionQueue = new Queue('predictionQueue', { connection });
const scheduler = new QueueScheduler('predictionQueue', { connection });

// Worker to process predictions asynchronously
const predictionWorker = new Worker(
    'predictionQueue',
    async (job: Job) => {
        // Simulate heavy prediction computation
        // For demonstration, we just hash the input data
        const input = job.data.input;
        const result = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');

        // Store result in cache
        const cacheKey = job.id as string;
        predictionCache.set(cacheKey, result);

        return { result };
    },
    { connection }
);

predictionWorker.on('failed', (job, err) => {
    console.error(`Job ${job?.id} failed:`, err);
});

// Express app setup
const app = express();
app.use(json());

// Global error handler
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Helper to generate deterministic cache key from request payload
function generateCacheKey(payload: any): string {
    // Formula: key = SHA256(JSON.stringify(payload))
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

// /predict endpoint
app.post(
    '/predict',
    jwtAuth,
    body('data').exists().withMessage('data field is required'),
    async (req: AuthenticatedRequest, res: Response) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const inputData = req.body.data;
        const cacheKey = generateCacheKey(inputData);

        // Check cache first
        const cachedResult = predictionCache.get(cacheKey);
        if (cachedResult) {
            return res.json({ cached: true, result: cachedResult });
        }

        try {
            const job = await predictionQueue.add('predict', { input: inputData }, { jobId: cacheKey });
            return res.json({ jobId: job.id, queued: true });
        } catch (err) {
            console.error('Failed to enqueue prediction job:', err);
            return res.status(500).json({ error: 'Failed to queue prediction' });
        }
    }
);

// /dashboard endpoint
app.get('/dashboard', jwtAuth, async (_req: AuthenticatedRequest, res: Response) => {
    try {
        const [waiting, active, completed, failed, delayed] = await Promise.all([
            predictionQueue.getWaitingCount(),
            predictionQueue.getActiveCount(),
            predictionQueue.getCompletedCount(),
            predictionQueue.getFailedCount(),
            predictionQueue.getDelayedCount(),
        ]);

        const cacheInfo = {
            size: predictionCache.size,
            maxSize: predictionCache.max,
            ttl: predictionCache.ttl,
        };

        return res.json({
            queue: {
                waiting,
                active,
                completed,
                failed,
                delayed,
            },
            cache: cacheInfo,
        });
    } catch (err) {
        console.error('Dashboard error:', err);
        return res.status(500).json({ error: 'Failed to retrieve dashboard data' });