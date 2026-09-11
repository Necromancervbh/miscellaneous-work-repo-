import express, { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { Queue, Job, QueueOptions, JobStatus } from 'bull';
import IORedis from 'ioredis';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ---------- Configuration ----------
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const PYTHON_SCRIPT_PATH = path.resolve(__dirname, 'python', 'forecast_worker.py');
const MAX_REQUESTS_PER_MINUTE = 30;

// ---------- Types ----------
interface AuthenticatedRequest extends Request {
  user?: JwtPayload | string;
}

// ---------- Input Validation ----------
const TimePointSchema = z.object({
  timestamp: z.union([z.string().datetime(), z.number()]),
  value: z.number(),
});

const ForecastRequestSchema = z.object({
  series: z.array(TimePointSchema).min(1, 'Series must contain at least one data point'),
});

// ---------- JWT Middleware ----------
function jwtAuthMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction) {
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

// ---------- Rate Limiting ----------
const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: MAX_REQUESTS_PER_MINUTE,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ---------- Bull Queue Setup ----------
const redisConnection = new IORedis(REDIS_URL);
const queueOptions: QueueOptions = {
  redis: {
    host: redisConnection.options.host,
    port: redisConnection.options.port,
    password: redisConnection.options.password,
  },
};
const forecastQueue = new Queue('forecastQueue', queueOptions);

// ---------- Helper: Write JSON to Temp File ----------
function writeTempJson(data: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), `forecast_${uuidv4()}.json`);
    fs.writeFile(tmpFile, JSON.stringify(data), (err) => {
      if (err) return reject(err);
      resolve(tmpFile);
    });
  });
}

// ---------- Helper: Execute Python Worker ----------
function runPythonWorker(inputFile: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const python = spawn('python3', [PYTHON_SCRIPT_PATH, inputFile]);

    let stdout = '';
    let stderr = '';

    python.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    python.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    python.on('close', (code) => {
      // Clean up temp file
      fs.unlink(inputFile, () => { /* ignore errors */ });

      if (code !== 0) {
        return reject(new Error(`Python process exited with code ${code}: ${stderr}`));
      }
      try {
        const result = JSON.parse(stdout);
        resolve(result);
      } catch (parseErr) {
        reject(new Error(`Failed to parse Python output: ${parseErr}`));
      }
    });

    python.on('error', (err) => {
      fs.unlink(inputFile, () => { /* ignore errors */ });
      reject(err);
    });
  });
}

// ---------- Queue Processor ----------
forecastQueue.process(async (job: Job) => {
  const { series } = job.data as { series: Array<{ timestamp: string | number; value: number }> };
  // Write input to temp file
  const inputFile = await writeTempJson({ series });
  // Run Python script
  const result = await runPythonWorker(inputFile);
  // Expected result shape: { forecast: Array<{ timestamp: string; lower: number; upper: number; mean: number }> }
  return result;
});

// ---------- Express Router ----------
const router = express.Router();

router.use(express.json());
router.use(jwtAuthMiddleware);
router.use(apiRateLimiter);

// POST /forecast - submit new forecasting job
router.post('/forecast', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const parsed = ForecastRequestSchema.parse(req.body);
    const jobId = uuidv4();
    await forecastQueue.add(
      { series: parsed.series },
      {
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      }
    );
    res.status(202).json({ jobId });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.errors.map(e => e.message).join(', ') });
    }
    console.error('Error submitting forecast job:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /forecast/:id - retrieve job status / result
router.get('/forecast/:id', async (req: AuthenticatedRequest, res: Response) => {
  const jobId = req.params.id;
  try {
    const job = await forecastQueue.getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });