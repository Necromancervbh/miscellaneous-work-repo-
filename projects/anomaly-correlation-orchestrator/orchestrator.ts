import express, { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { Queue, Worker, QueueScheduler, Job } from 'bullmq';
import IORedis from 'ioredis';
import { Server as WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import bodyParser from 'body-parser';
import { schedule as scheduleTask } from './scheduler';
import { aggregate as aggregateResults } from './aggregator';
import { explain as explainResults } from './explainability';
import { evaluate as evaluateResults } from './evaluator';
import dotenv from 'dotenv';

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || 'default_secret';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const PORT = parseInt(process.env.PORT || '3000', 10);

/**
 * Interface extending Express Request to include authenticated user payload.
 */
interface AuthenticatedRequest extends Request {
  user?: { id: string; [key: string]: any };
}

/**
 * JWT authentication middleware.
 * Verifies token and attaches payload to request object.
 */
function authenticateJWT(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header missing' });
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Bearer token missing' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET) as { id: string };
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Rate limiter: max 60 requests per minute per IP.
 */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Redis connection for BullMQ.
 */
const redisConnection = new IORedis(REDIS_URL);

/**
 * BullMQ queue and scheduler for task processing.
 */
const taskQueue = new Queue('tasks', { connection: redisConnection });
const taskQueueScheduler = new QueueScheduler('tasks', {
  connection: redisConnection,
});

/**
 * In‑memory map of userId => WebSocket connection.
 * Used to push results back to the originating client.
 */
const wsClients = new Map<string, WebSocket>();

/**
 * Helper to validate incoming task payload.
 */
function validateTaskPayload(payload: any): { valid: boolean; error?: string } {
  if (typeof payload !== 'object' || payload === null) {
    return { valid: false, error: 'Payload must be a JSON object' };
  }
  if (!payload.type || typeof payload.type !== 'string') {
    return { valid: false, error: 'Missing or invalid "type" field' };
  }
  // Additional domain‑specific validation can be added here.
  return { valid: true };
}

/**
 * Core processing pipeline.
 * Executes scheduler, aggregator, explainability, and evaluator sequentially.
 * Returns a combined result object.
 */
async function processTask(task: any, userId: string, jobId: string) {
  // Scheduler may produce a schedule object.
  const scheduleResult = await scheduleTask(task);
  // Aggregator consumes schedule result.
  const aggregationResult = await aggregateResults(scheduleResult);
  // Explainability consumes aggregation result.
  const explanationResult = await explainResults(aggregationResult);
  // Evaluator consumes explanation result.
  const evaluationResult = await evaluateResults(explanationResult);

  return {
    schedule: scheduleResult,
    aggregation: aggregationResult,
    explanation: explanationResult,
    evaluation: evaluationResult,
    meta: { userId, jobId },
  };
}

/**
 * BullMQ worker that processes queued tasks.
 * After processing, pushes result to the user's WebSocket if connected.
 */
const taskWorker = new Worker(
  'tasks',
  async (job: Job) => {
    const { task, userId, jobId } = job.data;
    try {
      const result = await processTask(task, userId, jobId);
      const ws = wsClients.get(userId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ jobId, status: 'completed', result }));
      }
      return result;
    } catch (err) {
      const ws = wsClients.get(userId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            jobId,
            status: 'failed',
            error: (err as Error).message,
          })
        );
      }
      throw err;
    }
  },
  { connection: redisConnection }
);

taskWorker.on('failed', (job, err) => {
  console.error(`Job ${job.id} failed:`, err);
});

/**
 * Express application setup.
 */
const app = express();
app.use(bodyParser.json());
app.use(apiLimiter);

/**
 * POST /tasks
 * Authenticated endpoint that enqueues a new task.
 */
app.post(
  '/tasks',
  authenticateJWT,
  async (req: AuthenticatedRequest, res: Response) => {
    const validation = validateTaskPayload(req.body);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    const userId = req.user!.id;
    const jobId = `${userId}-${Date.now()}-${Math.random()
      .toString(36)
      .substring(2, 8)}`;

    try {
      await taskQueue.add(
        'process',
        { task: req.body, userId, jobId },
        { jobId }
      );
      return res.status(202).json({ jobId, status: 'queued' });
    } catch (err) {
      console.error('Failed to