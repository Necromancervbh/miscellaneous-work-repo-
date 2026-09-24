import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import { Server as WebSocketServer, WebSocket } from 'ws';
import { Queue, Worker, QueueScheduler, Job } from 'bullmq';
import rateLimit from 'express-rate-limit';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { createProxyMiddleware, Options as ProxyOptions } from 'http-proxy-middleware';
import axios from 'axios';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import bodyParser from 'body-parser';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';

// Load environment variables
dotenv.config();

const {
    PORT = '3000',
    JWT_SECRET,
    FORECAST_SERVICE_URL,
    ALERT_SERVICE_URL,
    ML_SERVICE_URL,
    VISUALIZER_WS_URL,
    REDIS_HOST = '127.0.0.1',
    REDIS_PORT = '6379',
    RATE_LIMIT_WINDOW_MS = '60000', // 1 minute
    RATE_LIMIT_MAX = '100' // max requests per window per user
} = process.env;

// Validate required env vars
if (!JWT_SECRET) throw new Error('JWT_SECRET is not defined');
if (!FORECAST_SERVICE_URL) throw new Error('FORECAST_SERVICE_URL is not defined');
if (!ALERT_SERVICE_URL) throw new Error('ALERT_SERVICE_URL is not defined');
if (!ML_SERVICE_URL) throw new Error('ML_SERVICE_URL is not defined');
if (!VISUALIZER_WS_URL) throw new Error('VISUALIZER_WS_URL is not defined');

const app = express();

// Basic middleware
app.use(helmet());
app.use(cors());
app.use(morgan('combined'));
app.use(bodyParser.json());

// ---------- JWT Validation Middleware ----------
interface AuthenticatedRequest extends Request {
    user?: { id: string; [key: string]: any };
}

/**
 * Verifies JWT from Authorization header.
 * Expected format: "Bearer <token>"
 */
function jwtAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
        return res.status(401).json({ error: 'Missing Authorization header' });
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
        return res.status(401).json({ error: 'Invalid Authorization format' });
    }

    const token = parts[1];
    try {
        const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
        if (!payload.sub) {
            throw new Error('Token missing subject (sub) claim');
        }
        req.user = { id: payload.sub, ...payload };
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

// Apply JWT auth globally
app.use(jwtAuth);

// ---------- Per‑User Rate Limiting ----------
const userRateLimiter = rateLimit({
    windowMs: Number(RATE_LIMIT_WINDOW_MS),
    max: Number(RATE_LIMIT_MAX),
    keyGenerator: (req: AuthenticatedRequest) => req.user?.id ?? req.ip,
    handler: (req, res) => {
        res.status(429).json({ error: 'Too many requests, please try again later.' });
    },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(userRateLimiter);

// ---------- BullMQ Queue for Forecast Jobs ----------
const queueName = 'forecast-jobs';
const forecastQueue = new Queue(queueName, {
    connection: {
        host: REDIS_HOST,
        port: Number(REDIS_PORT),
    },
});
const forecastScheduler = new QueueScheduler(queueName, {
    connection: {
        host: REDIS_HOST,
        port: Number(REDIS_PORT),
    },
});

// Worker to process jobs (optional – can be in separate service)
const forecastWorker = new Worker(
    queueName,
    async (job: Job) => {
        // Forward job payload to forecasting service
        const response = await axios.post(`${FORECAST_SERVICE_URL}/process`, job.data, {
            headers: { 'Content-Type': 'application/json' },
        });
        return response.data;
    },
    {
        connection: {
            host: REDIS_HOST,
            port: Number(REDIS_PORT),
        },
    }
);
forecastWorker.on('failed', (job, err) => {
    console.error(`Forecast job ${job?.id} failed:`, err);
});

// ---------- API Endpoints ----------
/**
 * POST /forecast
 * Body: { input: any }
 * Enqueues a forecast job and returns job id.
 */
app.post('/forecast', async (req: AuthenticatedRequest, res: Response) => {
    const { input } = req.body;
    if (input === undefined) {
        return res.status(400).json({ error: 'Missing required field: input' });
    }

    try {
        const jobId = uuidv4();
        await forecastQueue.add(
            'forecast',
            { userId: req.user?.id, input },
            { jobId, removeOnComplete: true, removeOnFail: true }
        );
        res.status(202).json({ jobId });
    } catch (err) {
        console.error('Error enqueuing forecast job:', err);
        res.status(500).json({ error: 'Failed to enqueue forecast job' });
    }
});

/**
 * GET /forecast/:jobId/status
 * Returns job status and result if completed.
 */
app.get('/forecast/:jobId/status', async (req: AuthenticatedRequest, res: Response) => {
    const { jobId } = req.params;
    if (!jobId) {
        return res.status(400).json({ error: 'Missing jobId parameter' });
    }

    try {
        const job = await forecastQueue.getJob(jobId);
        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }

        const state = await job.getState();
        const result = state === 'completed' ? await job.returnvalue : null;
        res.json({ jobId, state, result });
    } catch (err) {
        console.error('Error fetching forecast job status:', err);
        res.status(500).json({ error: 'Failed to retrieve job status' });
    }
});

// Proxy to Alert Service
const alertProxyOptions: ProxyOptions = {
    target: ALERT_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/alert': '' },
    onError(err, req, res) {
        console.error('Alert service proxy error:', err);
        res.status(502).json({ error: 'Bad gateway to alert service' });
    },
};
app.use('/alert', createProxyMiddleware(alertProxyOptions));

// Proxy to ML Service
const mlProxyOptions: ProxyOptions = {
    target: ML_SERVICE_URL,
    changeOrigin: true,
    pathRewrite: { '^/ml': '' },
    onError(err, req, res) {
        console.error('ML service proxy error:', err);
        res.status(502).json({ error: 'Bad gateway to ML service' });
    },
};
app.use('/ml', createProxyMiddleware(mlProxyOptions));

// ---------- WebSocket Multiplexing ----------
/**
 * The gateway maintains a single upstream WebSocket connection to the visualizer.
 * It multiplexes incoming client connections, forwarding messages and broadcasting
 * responses back to the appropriate client(s).
 */
interface ClientInfo {
    ws: WebSocket;
    id: string;
}
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

let upstreamWs: WebSocket | null = null;
const pendingClients: Set<ClientInfo> = new Set();

/**
 * Establish or reuse upstream connection to visualizer.
 */
function getUpstreamWs(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
        if (upstreamWs && upstreamWs.ready