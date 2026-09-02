import express, { Request, Response, NextFunction } from 'express';
import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { Queue, Worker, QueueScheduler, Job } from 'bullmq';
import IORedis from 'ioredis';
import bodyParser from 'body-parser';
import { v4 as uuidv4 } from 'uuid';

// ---------- Configuration ----------
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const PORT = parseInt(process.env.PORT || '3000', 10);
const ANOMALY_THRESHOLD = parseFloat(process.env.ANOMALY_THRESHOLD || '3'); // 3 sigma

// ---------- Redis & Queue ----------
const connection = new IORedis(REDIS_URL);
const alertQueue = new Queue('alertQueue', { connection });
const queueScheduler = new QueueScheduler('alertQueue', { connection });
const alertWorker = new Worker(
  'alertQueue',
  async (job: Job) => {
    // Placeholder for background processing (e.g., persisting alerts, notifying external services)
    console.log(`Processing alert job ${job.id}:`, job.data);
  },
  { connection }
);

// ---------- Kalman Filter Implementation ----------
/**
 * Simple 1‑dimensional Kalman filter.
 * State equation:   x_k = x_{k-1}
 * Observation eq.:  z_k = x_k + v_k,   v_k ~ N(0, R)
 *
 * Predict step:
 *   x̂_k|k-1 = x̂_{k-1}|k-1
 *   P_k|k-1 = P_{k-1}|k-1 + Q
 *
 * Update step:
 *   K_k = P_k|k-1 / (P_k|k-1 + R)
 *   x̂_k|k = x̂_k|k-1 + K_k (z_k - x̂_k|k-1)
 *   P_k|k = (1 - K_k) P_k|k-1
 *
 * Q: process variance, R: measurement variance.
 */
class KalmanFilter {
  private q: number; // process variance
  private r: number; // measurement variance
  private x: number; // estimated value
  private p: number; // estimation error covariance
  private initialized: boolean;

  constructor(q = 1e-5, r = 0.01, initialValue = 0) {
    this.q = q;
    this.r = r;
    this.x = initialValue;
    this.p = 1;
    this.initialized = false;
  }

  predict(): void {
    // In 1‑D case, prediction is identity
    this.p = this.p + this.q;
  }

  update(measurement: number): { residual: number; sigma: number } {
    const k = this.p / (this.p + this.r); // Kalman gain
    const residual = measurement - this.x;
    this.x = this.x + k * residual;
    this.p = (1 - k) * this.p;
    const sigma = Math.sqrt(this.p);
    return { residual, sigma };
  }

  filter(measurement: number): { estimate: number; residual: number; sigma: number } {
    if (!this.initialized) {
      this.x = measurement;
      this.initialized = true;
    }
    this.predict();
    const { residual, sigma } = this.update(measurement);
    return { estimate: this.x, residual, sigma };
  }
}

// ---------- Per‑Series Filter Management ----------
interface SeriesState {
  filter: KalmanFilter;
  lastTimestamp: number;
}
const seriesMap = new Map<string, SeriesState>();

// ---------- JWT Middleware ----------
function authenticateJWT(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing Authorization header' });
    return;
  }
  const token = authHeader.split(' ')[1];
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      res.status(403).json({ error: 'Invalid token' });
      return;
    }
    // Attach user info if needed
    (req as any).user = decoded;
    next();
  });
}

// ---------- Rate Limiting ----------
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120, // limit each IP to 120 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_, res) => {
    res.status(429).json({ error: 'Too many requests, please try again later.' });
  },
});

// ---------- Express App ----------
const app = express();
app.use(bodyParser.json({ limit: '1mb' }));
app.use(apiLimiter);
app.use(authenticateJWT);

// ---------- WebSocket Server ----------
let wss: WebSocketServer;
function initWebSocket(server: HttpServer): void {
  wss = new WebSocketServer({ server });
  wss.on('connection', (ws: WebSocket) => {
    ws.send(JSON.stringify({ type: 'welcome', message: 'Connected to anomaly alert service' }));
  });
}

// ---------- Helper: Broadcast ----------
function broadcastAlert(alert: any): void {
  if (!wss) return;
  const payload = JSON.stringify({ type: 'alert', data: alert });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// ---------- Alert Endpoint ----------
interface AlertPayload {
  seriesId: string;
  timestamp: number; // epoch ms
  value: number;
}
app.post('/api/alert', async (req: Request, res: Response) => {
  const body: AlertPayload = req.body;
  // Input validation
  if (
    !body ||
    typeof body.seriesId !== 'string' ||
    typeof body.timestamp !== 'number' ||
    typeof body.value !== 'number'
  ) {
    res.status(400).json({ error: 'Invalid payload. Expected { seriesId, timestamp, value }' });
    return;
  }

  try {
    let state = seriesMap.get(body.seriesId);
    if (!state) {
      state = {
        filter: new KalmanFilter(),
        lastTimestamp: 0,
      };
      seriesMap.set(body.seriesId, state);
    }

    // Ensure timestamps are monotonic
    if (body.timestamp <= state.lastTimestamp) {
      res.status(400).json({ error: 'Timestamps must be strictly increasing' });
      return;
    }
    state.lastTimestamp = body.timestamp;

    const { estimate, residual, sigma } = state.filter.filter(body.value);
    const isAnomaly = Math.abs(residual) > ANOMALY_THRESHOLD * sigma;

    const alert = {
      id: uuidv4(),
      seriesId: body.seriesId,
      timestamp: body.timestamp,
      observed: body.value,
      estimated: estimate,
      residual,
      sigma,
      isAnomaly,
    };

    // Enqueue alert for async processing
    await alertQueue.add('processAlert', alert);

    // Broadcast via WebSocket
    broadcastAlert(alert);

    res.status(200).json({ alert });
  } catch (err) {
    console.error('Error processing alert:', err);
    res.status(500).json({ error: