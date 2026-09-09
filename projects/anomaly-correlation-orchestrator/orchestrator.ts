import express, { Request, Response, NextFunction } from 'express';
import { json } from 'body-parser';
import { Queue, Worker, QueueScheduler, Job } from 'bullmq';
import IORedis from 'ioredis';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import LRUCache from 'lru-cache';
import http from 'http';
import { Server as WebSocketServer, WebSocket } from 'ws';
import { AddressInfo } from 'net';
import { randomUUID } from 'crypto';

// Types
interface CorrelationMatrixPayload {
  clientId: string;
  timestamp: string; // ISO string
  matrix: number[][]; // square matrix
}

// Configuration defaults
const DEFAULT_HTTP_PORT = 3000;
const DEFAULT_WS_PORT = 3001;
const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379';
const RATE_LIMIT_POINTS = 10; // requests
const RATE_LIMIT_DURATION = 60; // per seconds
const LRU_MAX_ITEMS = 200;
const LRU_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

export class OrchestratorService {
  private readonly app = express();
  private readonly httpServer: http.Server;
  private readonly wsServer: WebSocketServer;
  private readonly redis: IORedis.Redis;
  private readonly queue: Queue;
  private readonly worker: Worker;
  private readonly queueScheduler: QueueScheduler;
  private readonly rateLimiter: RateLimiterRedis;
  private readonly cache: LRUCache<string, number[][]>;
  private readonly wsClients = new Set<WebSocket>();

  constructor(
    private readonly httpPort: number = DEFAULT_HTTP_PORT,
    private readonly wsPort: number = DEFAULT_WS_PORT,
    private readonly redisUrl: string = DEFAULT_REDIS_URL
  ) {
    // Initialize Redis connection
    this.redis = new IORedis(this.redisUrl);

    // Initialize BullMQ components
    this.queue = new Queue('correlation-jobs', { connection: this.redis });
    this.queueScheduler = new QueueScheduler('correlation-jobs', { connection: this.redis });
    this.worker = new Worker(
      'correlation-jobs',
      async (job: Job) => this.processJob(job),
      { connection: this.redis }
    );

    // Initialize rate limiter per client IP
    this.rateLimiter = new RateLimiterRedis({
      storeClient: this.redis,
      points: RATE_LIMIT_POINTS,
      duration: RATE_LIMIT_DURATION,
      keyPrefix: 'rlflx',
    });

    // Initialize LRU cache for recent matrices
    this.cache = new LRUCache<string, number[][]>({
      max: LRU_MAX_ITEMS,
      ttl: LRU_MAX_AGE_MS,
    });

    // Express middlewares
    this.app.use(json());
    this.app.use(this.rateLimitMiddleware.bind(this));
    this.app.use(this.errorHandler.bind(this));

    // Routes
    this.app.post('/correlation', this.handleCorrelation.bind(this));

    // HTTP server
    this.httpServer = http.createServer(this.app);

    // WebSocket server
    this.wsServer = new WebSocketServer({ noServer: true });
    this.wsServer.on('connection', this.handleWsConnection.bind(this));
    this.httpServer.on('upgrade', (request, socket, head) => {
      if (request.url === '/ws') {
        this.wsServer.handleUpgrade(request, socket, head, (ws) => {
          this.wsServer.emit('connection', ws, request);
        });
      } else {
        socket.destroy();
      }
    });

    // Worker event handling
    this.worker.on('completed', (job) => this.emitWsEvent('correlationCompleted', job.returnvalue));
    this.worker.on('failed', (job, err) => this.emitWsEvent('correlationFailed', { jobId: job?.id, error: err?.message }));
  }

  // Rate limiting middleware
  private async rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    const ip = req.ip;
    try {
      await this.rateLimiter.consume(ip);
      next();
    } catch (rlRejected) {
      res.status(429).json({ error: 'Too Many Requests' });
    }
  }

  // Input validation helper
  private validatePayload(payload: any): payload is CorrelationMatrixPayload {
    if (typeof payload !== 'object' || payload === null) return false;
    if (typeof payload.clientId !== 'string' || payload.clientId.trim() === '') return false;
    if (typeof payload.timestamp !== 'string' || isNaN(Date.parse(payload.timestamp))) return false;
    if (!Array.isArray(payload.matrix) || payload.matrix.length === 0) return false;
    const size = payload.matrix.length;
    for (const row of payload.matrix) {
      if (!Array.isArray(row) || row.length !== size) return false;
      for (const val of row) {
        if (typeof val !== 'number' || !isFinite(val)) return false;
      }
    }
    return true;
  }

  // POST /correlation handler
  private async handleCorrelation(req: Request, res: Response, next: NextFunction) {
    try {
      const payload = req.body;
      if (!this.validatePayload(payload)) {
        res.status(400).json({ error: 'Invalid payload' });
        return;
      }

      const cacheKey = `${payload.clientId}:${payload.timestamp}`;
      this.cache.set(cacheKey, payload.matrix);

      const jobId = randomUUID();
      await this.queue.add('process-correlation', payload, { jobId });

      res.status(202).json({ jobId });
    } catch (err) {
      next(err);
    }
  }

  // BullMQ job processor
  private async processJob(job: Job<CorrelationMatrixPayload>) {
    const { clientId, timestamp, matrix } = job.data;

    // Simulated processing: compute sum of all elements (example)
    // Formula: Σ_{i=1}^{n} Σ_{j=1}^{n} matrix[i][j]
    const total = matrix.reduce((accRow, row) => accRow + row.reduce((acc, val) => acc + val, 0), 0);

    // Simulate async work
    await new Promise((resolve) => setTimeout(resolve, 500));

    const result = {
      clientId,
      timestamp,
      total,
      processedAt: new Date().toISOString(),
    };
    return result;
  }

  // WebSocket connection handler
  private handleWsConnection(ws: WebSocket) {
    this.wsClients.add(ws);
    ws.on('close', () => {
      this.wsClients.delete(ws);
    });
  }

  // Emit event to all connected WebSocket clients
  private emitWsEvent(event: string, data: any) {
    const message = JSON.stringify({ event, data });
    for (const client of this.wsClients) {
      if (client.readyState === WebSocket.OPEN) {