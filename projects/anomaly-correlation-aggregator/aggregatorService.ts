import express, { Request, Response, NextFunction } from 'express';
import { json, urlencoded } from 'body-parser';
import { graphqlHTTP } from 'express-graphql';
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  GraphQLList,
  GraphQLNonNull,
  GraphQLInt,
} from 'graphql';
import jwt, { JwtPayload } from 'jsonwebtoken';
import fetch from 'node-fetch';
import LRUCache from 'lru-cache';
import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { RateLimiterMemory } from 'rate-limiter-flexible';

// ---------- Configuration ----------
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const RATE_LIMIT_POINTS = process.env.RATE_LIMIT_POINTS
  ? parseInt(process.env.RATE_LIMIT_POINTS, 10)
  : 100; // requests
const RATE_LIMIT_DURATION = process.env.RATE_LIMIT_DURATION
  ? parseInt(process.env.RATE_LIMIT_DURATION, 10)
  : 60; // seconds
const LRU_MAX_ITEMS = process.env.LRU_MAX_ITEMS
  ? parseInt(process.env.LRU_MAX_ITEMS, 10)
  : 500;
const LRU_MAX_AGE = process.env.LRU_MAX_AGE
  ? parseInt(process.env.LRU_MAX_AGE, 10)
  : 5 * 60 * 1000; // 5 minutes
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const SHAP_QUEUE_NAME = 'shapExplainQueue';

// ---------- Types ----------
interface AuthenticatedRequest extends Request {
  user?: { id: string; [key: string]: any };
}

// ---------- JWT Authentication Middleware ----------
function authenticateJWT(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
    if (!payload.sub) {
      throw new Error('Token missing subject');
    }
    req.user = { id: payload.sub, ...payload };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token', details: (err as Error).message });
  }
}

// ---------- Per‑User Rate Limiting ----------
const rateLimiter = new RateLimiterMemory({
  points: RATE_LIMIT_POINTS,
  duration: RATE_LIMIT_DURATION,
});

async function rateLimitMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  if (!req.user?.id) {
    // Should not happen because auth runs first
    return res.status(401).json({ error: 'Unauthenticated' });
  }
  try {
    await rateLimiter.consume(req.user.id);
    next();
  } catch (rej) {
    res.set('Retry-After', String(RATE_LIMIT_DURATION));
    return res.status(429).json({ error: 'Too Many Requests' });
  }
}

// ---------- LRU Cache ----------
const cache = new LRUCache<string, any>({
  max: LRU_MAX_ITEMS,
  ttl: LRU_MAX_AGE,
});

// Helper to generate cache keys
function cacheKey(req: Request): string {
  const url = req.originalUrl || req.url;
  const method = req.method;
  const body = JSON.stringify(req.body || {});
  return `${method}:${url}:${body}`;
}

// ---------- Async SHAP Explain Queue ----------
const connection = new IORedis(REDIS_URL);
const shapQueue = new Queue(SHAP_QUEUE_NAME, { connection });

const shapWorker = new Worker(
  SHAP_QUEUE_NAME,
  async (job: Job) => {
    // Placeholder for actual SHAP explain logic.
    // In production, replace with real model inference.
    const { anomalyId, payload } = job.data;
    // Simulate processing time
    await new Promise((resolve) => setTimeout(resolve, 2000));
    // Mock result
    const result = {
      anomalyId,
      explanation: `SHAP explanation for anomaly ${anomalyId}`,
      details: payload,
    };
    // In a real system, store result in DB or publish to a message bus.
    console.log('SHAP job completed:', result);
    return result;
  },
  { connection },
);

shapWorker.on('failed', (job, err) => {
  console.error(`SHAP job ${job?.id} failed:`, err);
});

// ---------- Downstream Service Proxy ----------
const ANOMALY_SERVICE_URL = process.env.ANOMALY_SERVICE_URL || 'http://localhost:5000';

// Generic function to forward GET requests with caching
async function fetchWithCache(path: string, query: Record<string, any>) {
  const url = new URL(`${ANOMALY_SERVICE_URL}${path}`);
  Object.entries(query).forEach(([k, v]) => url.searchParams.append(k, String(v)));
  const cacheKeyStr = `GET:${url.toString()}`;
  if (cache.has(cacheKeyStr)) {
    return cache.get(cacheKeyStr);
  }
  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upstream error ${response.status}: ${text}`);
  }
  const data = await response.json();
  cache.set(cacheKeyStr, data);
  return data;
}

// ---------- GraphQL Schema ----------
const AnomalyType = new GraphQLObjectType({
  name: 'Anomaly',
  fields: {
    id: { type: new GraphQLNonNull(GraphQLString) },
    metric: { type: GraphQLString },
    value: { type: GraphQLString },
    timestamp: { type: GraphQLString },
  },
});

const QueryType = new GraphQLObjectType({
  name: 'Query',
  fields: {
    anomalies: {
      type: new GraphQLList(AnomalyType),
      args: {
        metric: { type: GraphQLString },
        limit: { type: GraphQLInt },
      },
      async resolve(_parent, args, context) {
        // Input validation
        if (args.limit !== undefined && (args.limit < 1 || args.limit > 1000)) {
          throw new Error('limit must be between 1 and 1000');
        }
        const query: Record<string, any> = {};
        if (args.metric) query.metric = args.metric;
        if (args.limit) query.limit = args.limit;
        // Forward request
        const data = await fetchWithCache('/anomalies', query);
        return data;
      },
    },
  },
});

const MutationType = new GraphQLObjectType({
  name: 'Mutation',
  fields: {
    explainAnomaly: {
      type: GraphQLString, // Returns job ID
      args: {
        anomalyId: { type: new GraphQLNonNull(GraphQLString) },
        payload: { type: GraphQLString }, // optional additional data
      },
      async resolve(_parent, args, context) {
        const job = await shapQueue.add('