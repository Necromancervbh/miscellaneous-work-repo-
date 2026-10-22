import express, { Request, Response, NextFunction } from 'express';
import { Queue, Worker, Job, QueueScheduler, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const {
    PORT = '3000',
    REDIS_URL = 'redis://localhost:6379',
    JWT_SECRET = 'change_this_secret',
    MODEL_STORAGE_PATH = path.resolve(__dirname, 'models')
} = process.env;

// Ensure model storage directory exists
if (!fs.existsSync(MODEL_STORAGE_PATH)) {
    fs.mkdirSync(MODEL_STORAGE_PATH, { recursive: true });
}

// Initialize Redis connection
const connection = new IORedis(REDIS_URL);

// Queue and scheduler for training jobs
const trainingQueueName = 'model-training';
const trainingQueue = new Queue(trainingQueueName, { connection });
const trainingQueueScheduler = new QueueScheduler(trainingQueueName, { connection });
const trainingQueueEvents = new QueueEvents(trainingQueueName, { connection });

// Types
interface TrainRequestBody {
    dataPath: string; // absolute or relative path to training data
    parameters?: Record<string, any>;
}

interface JwtPayload {
    sub: string;
    iat: number;
    exp: number;
}

// Middleware for JWT authentication
function authenticateJwt(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or malformed Authorization header' });
    }
    const token = authHeader.slice(7);
    try {
        const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
        (req as any).user = payload;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid token' });
    }
}

// Helper: validate training request body
function validateTrainRequest(body: any): body is TrainRequestBody {
    if (typeof body !== 'object' || body === null) return false;
    if (typeof body.dataPath !== 'string' || body.dataPath.trim() === '') return false;
    if (body.parameters && typeof body.parameters !== 'object') return false;
    return true;
}

// Job processor: runs Python training script
async function processTrainingJob(job: Job) {
    const { dataPath, parameters } = job.data as TrainRequestBody;

    // Validate dataPath existence
    if (!fs.existsSync(dataPath)) {
        throw new Error(`Data file not found at path: ${dataPath}`);
    }

    // Generate version identifier (timestamp + uuid)
    const version = `${Date.now()}-${uuidv4()}`;
    const modelFileName = `model-${version}.pkl`; // Assuming Python pickles model
    const modelFilePath = path.join(MODEL_STORAGE_PATH, modelFileName);

    // Build arguments for Python script
    const scriptPath = path.resolve(__dirname, 'train_model.py');
    const args = [
        scriptPath,
        '--data', dataPath,
        '--output', modelFilePath
    ];

    if (parameters && typeof parameters === 'object') {
        for (const [key, value] of Object.entries(parameters)) {
            args.push(`--${key}`, String(value));
        }
    }

    // Spawn Python process
    return new Promise<void>((resolve, reject) => {
        const pyProcess = spawn('python3', args, { stdio: ['ignore', 'pipe', 'pipe'] });

        let stdout = '';
        let stderr = '';

        pyProcess.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        pyProcess.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        pyProcess.on('close', (code) => {
            if (code === 0) {
                // Attach version info to job result
                job.updateProgress(100);
                job.update({ version, modelPath: modelFilePath });
                resolve();
            } else {
                reject(new Error(`Training script exited with code ${code}: ${stderr}`));
            }
        });

        pyProcess.on('error', (err) => {
            reject(err);
        });
    });
}

// Initialize worker
const trainingWorker = new Worker(trainingQueueName, processTrainingJob, {
    connection,
    concurrency: 2,
    // Optional: limit job attempts
    limiter: { max: 5, duration: 60000 }
});

trainingWorker.on('failed', (job, err) => {
    console.error(`Job ${job?.id} failed:`, err);
});

trainingWorker.on('completed', (job) => {
    console.log(`Job ${job.id} completed. Model version: ${(job.data as any).version}`);
});

// Express app setup
const app = express();
app.use(express.json());

// Protected route: trigger training
app.post('/train', authenticateJwt, async (req: Request, res: Response) => {
    const body = req.body;
    if (!validateTrainRequest(body)) {
        return res.status(400).json({ error: 'Invalid request payload' });
    }

    try {
        const jobId = uuidv4();
        await trainingQueue.add(jobId, body, {
            jobId,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: true,
            removeOnFail: false
        });
        return res.status(202).json({ jobId });
    } catch (err) {
        console.error('Failed to enqueue training job:', err);
        return res.status(500).json({ error: 'Failed to schedule training job' });
    }
});

// Protected route: get job status
app.get('/status/:jobId', authenticateJwt, async (req: Request, res: Response) => {
    const { jobId } = req.params;
    try {
        const job = await trainingQueue.getJob(jobId);
        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }
        const state = await job.getState();
        const progress = job.progress;
        const result = job.returnvalue;
        const version = (job.data as any).version;
        return res.json({ jobId, state, progress, version, result });
    } catch (err) {
        console.error('Error fetching job status:', err);
        return res.status(500).json({ error: 'Failed to retrieve job status' });
    }
});

// Protected route: download model by version
app.get('/model/:version', authenticateJwt, async (req: Request, res: Response) => {
    const { version } = req.params;
    try {
        const files = fs.readdirSync(MODEL_STORAGE_PATH);
        const modelFile = files.find(f => f.includes(`model-${version}`));
        if (!modelFile) {
            return res.status(404).json({ error: 'Model version not found' });
        }
        const filePath = path.join(MODEL_STORAGE_PATH, modelFile);
        res.download(filePath, modelFile, (err) => {
            if (err) {
                console.error('Error sending model file:', err);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Failed to send model file' });
                }
            }
        });
    } catch (err) {
        console.error('Error retrieving model:', err);
        return res.status(500).json({ error: 'Failed to retrieve model' });
    }
});

// Health check
app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
});

// Global error