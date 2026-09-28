import express, { Request, Response, NextFunction, Application } from 'express';
import { json } from 'body-parser';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import LRUCache from 'lru-cache';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { Server as WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { v4 as uuidv4 } from 'uuid';
import { analytics } from './modules/analytics';
import { forecasting } from './modules/forecasting';
import { insight } from './modules/insight';
import { alert } from './modules/alert';

// -------------------- Configuration --------------------
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const PORT = Number(process.env.PORT) || 3000;

// LRU Cache configuration: max 500 items, max age 10 minutes
const resultCache = new LRUCache<string, any>({
  max: 500,
  ttl: 1000 * 60 * 10, // 10 minutes
});

// Rate limiter for alerts: max 5 alerts per minute per user
const alertRateLimiter = new RateLimiterMemory({
  points: 5,
  duration: 60,
});

// -------------------- Types --------------------
interface AuthenticatedRequest extends Request {
  user?: JwtPayload & { sub: string };
}

interface AnomalyRequestBody {
  data: number[];
  meta?: Record<string, any>;
}

// -------------------- Middleware --------------------
function requestLogger(req: Request, _res: Response, next: NextFunction): void {
  console.info(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
}

function authenticateJWT(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return next({ status: 401, message: 'Missing or malformed Authorization header' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload & { sub: string };
    req.user = payload;
    next();
  } catch (err) {
    next({ status: 401, message: 'Invalid token' });
  }
}

// Centralized error handler
function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction): void {
  const status = err.status || 500;
  const message = err.message || 'Internal Server Error';
  console.error(`[Error] ${status} - ${message}`, err.stack);
  res.status(status).json({ error: message });
}

// -------------------- Orchestrator Service --------------------
export class OrchestratorService {
  private app: Application;
  private server: http.Server;
  private wss: WebSocketServer;
  private queue: Queue;
  private worker: Worker;
  private redisConnection: IORedis.Redis;

  constructor() {
    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });
    this.redisConnection = new IORedis(REDIS_URL);
    this.queue = new Queue('anomaly-jobs', { connection: this.redisConnection });

    this.configureMiddleware();
    this.registerRoutes();
    this.configureWebSocket();
    this.configureWorker();
    this.handleProcessSignals();
  }

  // -------------------- Middleware Setup --------------------
  private configureMiddleware(): void {
    this.app.use(requestLogger);
    this.app.use(json({ limit: '1mb' }));
    this.app.use(authenticateJWT);
    this.app.use(errorHandler);
  }

  // -------------------- Routes --------------------
  private registerRoutes(): void {
    this.app.post('/anomaly', this.handleAnomalyRequest.bind(this));
    this.app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  }

  private async handleAnomalyRequest(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      // Input validation
      const body: Partial<AnomalyRequestBody> = req.body;
      if (!body || !Array.isArray(body.data) || body.data.length === 0) {
        throw { status: 400, message: 'Invalid request: "data" must be a non‑empty array of numbers' };
      }
      if (!body.data.every((v) => typeof v === 'number')) {
        throw { status: 400, message: '"data" array must contain only numbers' };
      }

      const jobId = uuidv4();
      const payload = {
        jobId,
        userId: req.user?.sub,
        data: body.data,
        meta: body.meta || {},
      };

      // Enqueue job
      await this.queue.add('process-anomaly', payload, { jobId });

      res.status(202).json({ jobId, status: 'queued' });
    } catch (err) {
      next(err);
    }
  }

  // -------------------- WebSocket --------------------
  private configureWebSocket(): void {
    this.wss.on('connection', (ws: WebSocket, req) => {
      const token = new URLSearchParams(req.url?.split('?')[1] || '').get('token');
      if (!token) {
        ws.close(4001, 'Missing token');
        return;
      }
      try {
        const payload = jwt.verify(token, JWT_SECRET) as JwtPayload & { sub: string };
        (ws as any).userId = payload.sub;
        ws.send(JSON.stringify({ type: 'welcome', userId: payload.sub }));
      } catch {
        ws.close(4002, 'Invalid token');
      }
    });
  }

  private broadcastResult(userId: string, message: any): void {
    const data = JSON.stringify(message);
    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN && (client as any).userId === userId) {
        client.send(data);
      }
    });
  }

  // -------------------- Worker --------------------
  private configureWorker(): void {
    this.worker = new Worker(
      'anomaly-jobs',
      async (job: Job) => {
        const { jobId, userId, data, meta } = job.data as {
          jobId: string;
          userId: string;
          data: number[];
          meta: Record<string, any>;
        };

        // Check cache first
        const cacheKey = `${userId}:${jobId}`;
        if (resultCache.has(cacheKey)) {
          return resultCache.get(cacheKey);
        }

        // Run analytics pipeline
        const analyticsResult = await analytics(data);
        const forecastResult = await forecasting(analyticsResult);
        const insightResult = await insight(forecastResult);
        const alertResult = await alert(insightResult);

        // Rate‑limit alerts per user
        try {
          await alertRateLimiter.consume(userId);
        } catch {
          // Exceeded rate limit: suppress alert
          console.warn(`Alert rate limit exceeded for user ${userId}`);
        }

        const finalResult = {
          jobId,
          userId,
          analytics: analyticsResult,
          forecast: forecastResult,
          insight: insightResult,
          alert: alertResult,
          meta,
        };

        // Cache result
        resultCache.set(cacheKey, finalResult);

        // Stream via WebSocket
        this.broadcastResult(userId, { type: 'anomalyResult', payload: finalResult });

        return finalResult