import express, { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { createServer } from 'http';
import { Server as WebSocketServer, WebSocket } from 'ws';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

// ---------- Configuration ----------
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const MODEL_SCRIPT_PATH = path.resolve(__dirname, 'run_model.py'); // Python script that loads model & runs inference
const PORT = Number(process.env.PORT) || 3000;
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 30; // max requests per window per IP
const CREDIBLE_INTERVAL_CONFIDENCE = 0.95; // 95% credible interval

// ---------- Redis Client ----------
const redis = new Redis(REDIS_URL);

// ---------- Express App ----------
const app = express();
app.use(express.json());

// ---------- Rate Limiter ----------
const apiLimiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
        res.status(429).json({ error: 'Too many requests, please try again later.' });
    },
});
app.use('/evaluate', apiLimiter);

// ---------- JWT Middleware ----------
function authenticateJWT(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or malformed Authorization header.' });
    }
    const token = authHeader.split(' ')[1];
    jwt.verify(token, JWT_SECRET, (err, _decoded) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid token.' });
        }
        next();
    });
}

// ---------- WebSocket Management ----------
interface WSClientMap {
    [jobId: string]: Set<WebSocket>;
}
const wsClients: WSClientMap = {};

function broadcastJobCompletion(jobId: string, payload: any) {
    const clients = wsClients[jobId];
    if (clients) {
        const message = JSON.stringify({ jobId, status: 'completed', result: payload });
        for (const ws of clients) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(message);
            }
        }
        // Cleanup after notification
        delete wsClients[jobId];
    }
}

// ---------- Helper Functions ----------
const access = promisify(fs.access);
async function validateFileExists(filePath: string): Promise<void> {
    try {
        await access(filePath, fs.constants.R_OK);
    } catch {
        throw new Error(`File not found or not readable: ${filePath}`);
    }
}

/**
 * Runs the Python inference script.
 * Expected output (JSON):
 * {
 *   "predictions": [0,1,0,...],
 *   "labels": [0,1,0,...]
 * }
 */
function runBatchInference(testDataPath: string): Promise<{ predictions: number[]; labels: number[] }> {
    return new Promise((resolve, reject) => {
        const py = spawn('python', [MODEL_SCRIPT_PATH, '--test', testDataPath], { stdio: ['ignore', 'pipe', 'pipe'] });

        let stdout = '';
        let stderr = '';

        py.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        py.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        py.on('close', (code) => {
            if (code !== 0) {
                return reject(new Error(`Python script exited with code ${code}: ${stderr}`));
            }
            try {
                const result = JSON.parse(stdout);
                if (!Array.isArray(result.predictions) || !Array.isArray(result.labels)) {
                    throw new Error('Invalid output format from Python script.');
                }
                resolve({ predictions: result.predictions, labels: result.labels });
            } catch (e) {
                reject(new Error(`Failed to parse Python output: ${(e as Error).message}`));
            }
        });
    });
}

/**
 * Computes precision, recall, and F1 score.
 * @param predictions Binary predictions (0 or 1)
 * @param labels Ground truth binary labels (0 or 1)
 * @returns Object with precision, recall, f1
 */
function computeMetrics(predictions: number[], labels: number[]) {
    if (predictions.length !== labels.length) {
        throw new Error('Predictions and labels must have the same length.');
    }
    let tp = 0,
        fp = 0,
        fn = 0;
    for (let i = 0; i < predictions.length; i++) {
        const pred = predictions[i];
        const trueLabel = labels[i];
        if (pred === 1 && trueLabel === 1) tp++;
        else if (pred === 1 && trueLabel === 0) fp++;
        else if (pred === 0 && trueLabel === 1) fn++;
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    return { precision, recall, f1, tp, fp, fn };
}

/**
 * Computes Bayesian credible interval for a proportion using Beta posterior.
 * Prior: Beta(1,1) (uniform). Posterior: Beta(α + successes, β + failures)
 * @param successes Number of successes (e.g., true positives)
 * @param trials Total trials (e.g., true positives + false positives)
 * @param confidence Desired confidence level (e.g., 0.95)
 * @returns [lowerBound, upperBound]
 */
function computeCredibleInterval(successes: number, trials: number, confidence: number): [number, number] {
    const alpha = 1 + successes;
    const beta = 1 + trials - successes;
    // Use inverse incomplete beta function approximation via jStat if available.
    // Since we avoid extra dependencies, we approximate using normal approximation for large counts.
    const mean = alpha / (alpha + beta);
    const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));
    const std = Math.sqrt(variance);
    const z = inverseStandardNormal((1 + confidence) / 2);
    const lower = Math.max(0, mean - z * std);
    const upper = Math.min(1, mean + z * std);
    return [lower, upper];
}

/**
 * Approximate inverse CDF of standard normal distribution (Probit function).
 * Uses Beasley–Springer–Moro algorithm.