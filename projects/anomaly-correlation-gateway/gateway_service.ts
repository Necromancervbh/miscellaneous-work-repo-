import express, { Request, Response, NextFunction } from 'express';
import { json } from 'body-parser';
import cors from 'cors';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { Queue, Worker, QueueScheduler, Job } from 'bullmq';
import IORedis from 'ioredis';
import axios, { AxiosResponse } from 'axios';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import http from 'http';

// Load environment variables
dotenv.config();

const {
    PORT = '3000',
    JWT_SECRET = 'your_jwt_secret',
    REDIS_URL = 'redis://127.0.0.1:6379',
    EXPLAINER_ENDPOINT = 'http://localhost:4001/explain',
    AGGREGATOR_ENDPOINT = 'http://localhost:4002/aggregate',
    DASHBOARD_ENDPOINT = 'http://localhost:4003/dashboard',
    RATE_LIMIT_CAPACITY = '10',
    RATE_LIMIT_REFILL_RATE = '1', // tokens per second
} = process.env;

// ---------- Redis & BullMQ Setup ----------
const connection = new IORedis(REDIS_URL);
const queueName = 'gateway-request-queue';
const requestQueue = new Queue(queueName, { connection });
const queueScheduler = new QueueScheduler(queueName, { connection });

// ---------- Token Bucket Rate Limiter ----------
interface TokenBucket {
    tokens: number;
    lastRefill: number; // epoch ms
}

/**
 * Calculates the number of tokens to add based on elapsed time.
 * tokensToAdd = elapsedSeconds * refillRate
 * New token count = min(capacity, currentTokens + tokensToAdd)
 */
async function getTokenBucket(userId: string): Promise<TokenBucket> {
    const key = `rate_limit:${userId}`;
    const data = await connection.hgetall(key);
    if (!data || Object.keys(data).length === 0) {
        // Initialize bucket
        const bucket: TokenBucket = {
            tokens: Number(RATE_LIMIT_CAPACITY),
            lastRefill: Date.now(),
        };
        await connection.hmset(key, {
            tokens: bucket.tokens,
            lastRefill: bucket.lastRefill,
        });
        return bucket;
    }
    return {
        tokens: Number(data.tokens),
        lastRefill: Number(data.lastRefill),
    };
}

async function saveTokenBucket(userId: string, bucket: TokenBucket): Promise<void> {
    const key = `rate_limit:${userId}`;
    await connection.hmset(key, {
        tokens: bucket.tokens,
        lastRefill: bucket.lastRefill,
    });
}

/**
 * Attempts to consume a token for the given user.
 * Returns true if successful, false otherwise.
 */
async function consumeToken(userId: string): Promise<boolean> {
    const capacity = Number(RATE_LIMIT_CAPACITY);
    const refillRate = Number(RATE_LIMIT_REFILL_RATE); // tokens per second

    const bucket = await getTokenBucket(userId);
    const now = Date.now();
    const elapsedMs = now - bucket.lastRefill;
    const elapsedSec = elapsedMs / 1000;

    // Refill tokens based on elapsed time
    const tokensToAdd = elapsedSec * refillRate;
    bucket.tokens = Math.min(capacity, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        await saveTokenBucket(userId, bucket);
        return true;
    } else {
        await saveTokenBucket(userId, bucket);
        return false;
    }
}

// ---------- JWT Middleware ----------
interface AuthenticatedRequest extends Request {
    user?: { id: string; [key: string]: any };
}

function jwtMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
        return res.status(401).json({ error: 'Missing Authorization header' });
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'Malformed Authorization header' });
    }

    try {
        const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
        if (!payload.sub) {
            throw new Error('JWT missing subject');
        }
        req.user = { id: payload.sub, ...payload };
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid token', details: (err as Error).message });
    }
}

// ---------- Rate Limiting Middleware ----------
async function rateLimitMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    if (!req.user?.id) {
        return res.status(500).json({ error: 'User ID missing after authentication' });
    }

    const allowed = await consumeToken(req.user.id);
    if (!allowed) {
        return res.status(429).json({ error: 'Rate limit exceeded' });
    }
    next();
}

// ---------- Request Forwarding ----------
type JobPayload = {
    jobId: string;
    userId: string;
    endpoint: 'explainer' | 'aggregator' | 'dashboard';
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    headers: Record<string, string>;
    body?: any;
    query?: Record<string, string | string[]>;
};

async function enqueueRequest(payload: JobPayload): Promise<Job> {
    return requestQueue.add(payload.endpoint, payload, {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 1000,
        },
        removeOnComplete: true,
        removeOnFail: false,
    });
}

// ---------- Express App ----------
const app = express();
app.use(cors());
app.use(json());

// Apply JWT and rate limiting globally for the three routes
app.use(['/explainer', '/aggregator', '/dashboard'], jwtMiddleware, rateLimitMiddleware);

// Helper to extract request data into JobPayload
function buildJobPayload(
    req: AuthenticatedRequest,
    endpoint: 'explainer' | 'aggregator' | 'dashboard'
): JobPayload {
    const jobId = uuidv4();
    const userId = req.user!.id;
    const method = req.method as JobPayload['method'];
    const headers: Record<string, string> = {};

    // Forward only safe headers
    const forwardHeaders = ['content-type', 'accept'];
    for (const h of forwardHeaders) {
        if (req.headers[h]) {
            headers[h] = Array.isArray(req.headers[h])
                ? req.headers[h].join(',')
                : (req.headers[h] as string);
        }
    }

    return {
        jobId,
        userId,
        endpoint,
        method,
        headers,
        body: req.body,
        query: req.query as Record<string, string | string[]>,
    };
}

// Route Handlers
app.all('/explainer', async (req: AuthenticatedRequest, res: Response) => {
    try {
        const payload = buildJobPayload(req, 'explainer');
        await enqueueRequest(payload);
        res.status(202).json({ jobId: payload.jobId, status: 'queued' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to enqueue request', details: (err as Error).message });
    }
});

app.all('/aggregator', async (req: AuthenticatedRequest, res: Response) => {
    try {
        const payload = buildJobPayload(req, 'aggregator');
        await enqueueRequest(payload);
        res.status(202).json({ jobId: payload