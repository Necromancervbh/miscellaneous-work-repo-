import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { createClient, RedisClientType } from 'redis';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';
import { randomBytes } from 'crypto';
import { promisify } from 'util';
import { EventEmitter } from 'events';

/**
 * Configuration constants.
 * Adjust these values according to your deployment environment.
 */
const JWT_SECRET = process.env.JWT_SECRET ?? '';
if (!JWT_SECRET) {
    throw new Error('Environment variable JWT_SECRET must be set');
}
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const RATE_LIMIT_CAPACITY = Number(process.env.RATE_LIMIT_CAPACITY) || 100; // max tokens
const RATE_LIMIT_REFILL_RATE = Number(process.env.RATE_LIMIT_REFILL_RATE) || 100; // tokens per minute
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS) || 3600; // 1 hour

/**
 * JWT authentication middleware.
 * Expects Authorization header in the form "Bearer <token>".
 */
function authenticateJWT(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ error: 'Missing Authorization header' });
    }
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
        return res.status(400).json({ error: 'Invalid Authorization header format' });
    }
    const token = parts[1];
    try {
        const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
        (req as any).user = payload;
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Invalid or expired token' });
    }
}

/**
 * Token bucket rate limiter.
 * Implements a classic token‑bucket algorithm:
 *   tokens = min(capacity, tokens + refill_rate * elapsed_time)
 *   if tokens >= 1 => allow request and decrement token count
 *   else => reject with 429.
 */
interface Bucket {
    tokens: number;
    lastRefill: number; // epoch ms
}
const buckets = new Map<string, Bucket>();

function getBucketKey(req: Request): string {
    // Prefer X-Forwarded-For header for real client IP behind proxies.
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') {
        return forwarded.split(',')[0].trim();
    }
    return req.ip;
}

function rateLimiter(req: Request, res: Response, next: NextFunction) {
    const key = getBucketKey(req);
    const now = Date.now();
    const bucket = buckets.get(key) ?? { tokens: RATE_LIMIT_CAPACITY, lastRefill: now };
    const elapsedMs = now - bucket.lastRefill;
    const refillTokens = (elapsedMs / 60000) * RATE_LIMIT_REFILL_RATE; // rate per minute
    bucket.tokens = Math.min(RATE_LIMIT_CAPACITY, bucket.tokens + refillTokens);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        buckets.set(key, bucket);
        next();
    } else {
        res.status(429).json({ error: 'Too Many Requests' });
    }
}

/**
 * Redis LRU cache wrapper.
 * Relies on Redis server configured with maxmemory-policy allkeys-lru.
 */
class RedisCache {
    private client: RedisClientType;

    constructor() {
        this.client = createClient({ url: REDIS_URL });
        this.client.on('error', (err) => console.error('Redis client error:', err));
        this.client.connect().catch((err) => {
            console.error('Failed to connect to Redis:', err);
            process.exit(1);
        });
    }

    async get<T = any>(key: string): Promise<T | null> {
        const raw = await this.client.get(key);
        if (raw === null) return null;
        try {
            return JSON.parse(raw) as T;
        } catch {
            return null;
        }
    }

    async set<T = any>(key: string, value: T, ttlSeconds: number = CACHE_TTL_SECONDS): Promise<void> {
        const serialized = JSON.stringify(value);
        await this.client.set(key, serialized, {
            EX: ttlSeconds,
        });
    }

    async del(key: string): Promise<void> {
        await this.client.del(key);
    }

    async subscribe(channel: string, handler: (message: string) => void): Promise<void> {
        const sub = this.client.duplicate();
        await sub.connect();
        await sub.subscribe(channel, (msg) => handler(msg));
    }
}

/**
 * WebSocket manager for broadcasting anomaly alerts.
 */
class AlertBroadcaster extends EventEmitter {
    private wss: WebSocketServer;
    private clients = new Set<WebSocket>();

    constructor(server: http.Server) {
        super();
        this.wss = new WebSocketServer({ server, path: '/ws/alerts' });
        this.wss.on('connection', (ws: WebSocket, req) => {
            // Simple origin check (optional)
            const origin = req.headers.origin;
            if (origin && new URL(origin).hostname !== new URL(req.url ?? '', `http://${req.headers.host}`).hostname) {
                ws.close(1008, 'Invalid origin');
                return;
            }
            this.clients.add(ws);
            ws.on('close', () => this.clients.delete(ws));
        });
    }

    broadcastAlert(alert: any) {
        const payload = JSON.stringify(alert);
        for (const ws of this.clients) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(payload);
            }
        }
    }
}

/**
 * Express application setup.
 */
export function createApp(): express.Express {
    const app = express();
    app.use(express.json());

    // Apply middlewares globally
    app.use(authenticateJWT);
    app.use(rateLimiter);

    const cache = new RedisCache();

    /**
     * Example endpoint that returns anomaly data.
     * Results are cached in Redis LRU cache.
     */
    app.get('/anomalies/:id', async (req: Request, res: Response) => {
        const id = req.params.id;
        if (!/^[a-f0-9]{24}$/.test(id)) {
            return res.status(400).json({ error: 'Invalid anomaly ID format' });
        }
        const cacheKey = `anomaly:${