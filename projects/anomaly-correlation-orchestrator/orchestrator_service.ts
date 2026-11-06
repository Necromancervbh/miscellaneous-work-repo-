import express, { Request, Response, NextFunction } from 'express';
import bodyParser from 'body-parser';
import jwt, { JwtPayload } from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { createClient, RedisClientType } from 'redis';
import { v4 as uuidv4 } from 'uuid';
import { promisify } from 'util';

// ---------- Configuration ----------
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const RESULT_TTL_SECONDS = 60 * 60; // 1 hour

// ---------- Redis Client ----------
const redis: RedisClientType = createClient({ url: REDIS_URL });
redis.on('error', (err) => console.error('Redis Client Error', err));
await redis.connect();

// ---------- Express App ----------
const app = express();
app.use(bodyParser.json());

// ---------- Rate Limiting ----------
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // limit each IP to 60 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'Too many requests, please try again later.' });
  },
});
app.use(apiLimiter);

// ---------- JWT Authentication ----------
interface AuthenticatedRequest extends Request {
  user?: string | JwtPayload;
}
function authenticateJWT(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header missing or malformed.' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

// ---------- Types ----------
type TaskType = 'ensemble' | 'analytics' | 'forecasting';

interface TaskPayload {
  data: any; // flexible payload; validation occurs per endpoint
}

interface TaskRecord {
  id: string;
  type: TaskType;
  status: 'pending' | 'completed' | 'failed';
  createdAt: number; // epoch ms
  result?: any;
  error?: string;
}

// ---------- Helper Functions ----------
function validatePayload(payload: any): boolean {
  // Basic validation: must be an object with a non‑empty 'data' field
  return typeof payload === 'object' && payload !== null && payload.hasOwnProperty('data');
}

/**
 * Simulate async processing.
 * For production, replace with actual computation or a job queue like BullMQ.
 * The result is stored in Redis under key `result:${taskId}`.
 *
 * Formula (example):
 *   result = Σ_i data_i * weight_i   // placeholder linear combination
 */
async function processTask(task: TaskRecord): Promise<void> {
  try {
    // Simulate variable processing time (1‑5 seconds)
    const delayMs = 1000 + Math.random() * 4000;
    await new Promise((resolve) => setTimeout(resolve, delayMs));

    // Placeholder computation: if data is an array of numbers, sum them
    let result: any;
    if (Array.isArray(task.payload?.data)) {
      result = (task.payload.data as number[]).reduce((a, b) => a + b, 0);
    } else {
      result = { message: 'Processed', original: task.payload?.data };
    }

    const completedTask: TaskRecord = {
      ...task,
      status: 'completed',
      result,
    };
    await redis.set(`task:${task.id}`, JSON.stringify(completedTask));
    await redis.set(`result:${task.id}`, JSON.stringify(result), {
      EX: RESULT_TTL_SECONDS,
    });
  } catch (err: any) {
    const failedTask: TaskRecord = {
      ...task,
      status: 'failed',
      error: err.message ?? 'Unknown error',
    };
    await redis.set(`task:${task.id}`, JSON.stringify(failedTask));
  }
}

/**
 * Schedule a new task.
 * Stores a pending task record in Redis and triggers async processing.
 */
async function scheduleTask(type: TaskType, payload: TaskPayload): Promise<string> {
  const taskId = uuidv4();
  const taskRecord: TaskRecord = {
    id: taskId,
    type,
    status: 'pending',
    createdAt: Date.now(),
    payload,
  };
  await redis.set(`task:${taskId}`, JSON.stringify(taskRecord));
  // Fire‑and‑forget processing
  processTask(taskRecord).catch((e) => console.error('Task processing error:', e));
  return taskId;
}

// ---------- Routes ----------
app.post('/tasks/:type', authenticateJWT, async (req: AuthenticatedRequest, res: Response) => {
  const { type } = req.params;
  if (!['ensemble', 'analytics', 'forecasting'].includes(type)) {
    return res.status(400).json({ error: 'Invalid task type.' });
  }
  const payload = req.body as TaskPayload;
  if (!validatePayload(payload)) {
    return res.status(400).json({ error: 'Invalid payload. Must contain a non‑empty "data" field.' });
  }
  try {
    const taskId = await scheduleTask(type as TaskType, payload);
    res.status(202).json({ taskId, status: 'pending' });
  } catch (err: any) {
    console.error('Scheduling error:', err);
    res.status(500).json({ error: 'Failed to schedule task.' });
  }
});

app.get('/results/:taskId', authenticateJWT, async (req: AuthenticatedRequest, res: Response) => {
  const { taskId } = req.params;
  if (!taskId) {
    return res.status(400).json({ error: 'Task ID is required.' });
  }
  try {
    const result = await redis.get(`result:${taskId}`);
    if (result) {
      return res.json({ taskId, status: 'completed', result: JSON.parse(result) });
    }
    const taskRaw = await redis.get(`task:${taskId}`);
    if (!taskRaw) {
      return res.status(404).json({ error: 'Task not found.' });
    }
    const task: TaskRecord = JSON.parse(taskRaw);
    if (task.status === 'failed') {
      return res.status(500).json({ taskId, status: 'failed', error: task.error });
    }
    return res.json({ taskId, status: task.status });
  } catch (err: any) {
    console.error('Result retrieval error:', err);
    res.status(500).json({ error: 'Failed to retrieve result.' });
  }
});

// ---------- Health Check ----------
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// ---------- Server Startup ----------
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Orchestrator service listening on port ${PORT}`);
  });
}

// Export