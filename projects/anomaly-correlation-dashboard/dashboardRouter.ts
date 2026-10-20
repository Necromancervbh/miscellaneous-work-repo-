import express, { Request, Response, NextFunction, Router } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import axios, { AxiosResponse } from 'axios';
import NodeCache from 'node-cache';
import { Server as HttpServer } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { EventEmitter } from 'events';
import { URL } from 'url';

// ---------- Configuration ----------
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const PREDICTION_SERVICE_URL = process.env.PREDICTION_SERVICE_URL || 'http://localhost:4000/predictions';
const METRICS_SERVICE_URL = process.env.METRICS_SERVICE_URL || 'http://localhost:4001/metrics';
const ALERTS_SERVICE_URL = process.env.ALERTS_SERVICE_URL || 'http://localhost:4002/alerts';

const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 100; // max requests per window

const PREDICTION_CACHE_TTL = Number(process.env.PREDICTION_CACHE_TTL) || 60; // seconds

// ---------- JWT Authentication Middleware ----------
interface AuthenticatedRequest extends Request {
  user?: string | JwtPayload;
}

function jwtAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ---------- Rate Limiting ----------
const apiRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_, res) => {
    res.status(429).json({ error: 'Too many requests, please try again later.' });
  },
});

// ---------- Caching ----------
const predictionCache = new NodeCache({ stdTTL: PREDICTION_CACHE_TTL, checkperiod: PREDICTION_CACHE_TTL / 2 });

/**
 * Fetch recent predictions from the prediction service.
 * Uses in‑memory cache to reduce load.
 *
 * Formula for cache expiration:
 *   ttl = PREDICTION_CACHE_TTL seconds
 */
async function getRecentPredictions(): Promise<any> {
  const cacheKey = 'recent_predictions';
  const cached = predictionCache.get<any>(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const response: AxiosResponse = await axios.get(PREDICTION_SERVICE_URL, {
      timeout: 5000,
    });
    predictionCache.set(cacheKey, response.data);
    return response.data;
  } catch (err) {
    throw new Error(`Failed to fetch predictions: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------- Data Aggregation ----------
interface AggregatedData {
  predictions: any;
  metrics: any;
  alerts: any;
}

/**
 * Aggregate data from prediction, metrics, and alerts services.
 * All requests are performed in parallel to minimize latency.
 */
async function aggregateDashboardData(): Promise<AggregatedData> {
  const predictionsPromise = getRecentPredictions();
  const metricsPromise = axios.get(METRICS_SERVICE_URL, { timeout: 5000 });
  const alertsPromise = axios.get(ALERTS_SERVICE_URL, { timeout: 5000 });

  try {
    const [predictions, metricsRes, alertsRes] = await Promise.all([
      predictionsPromise,
      metricsPromise,
      alertsPromise,
    ]);

    return {
      predictions,
      metrics: metricsRes.data,
      alerts: alertsRes.data,
    };
  } catch (err) {
    throw new Error(`Data aggregation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------- Express Router ----------
const router: Router = express.Router();

// Apply middlewares globally to the router
router.use(jwtAuth);
router.use(apiRateLimiter);

/**
 * GET /dashboard/summary
 * Returns aggregated data for the dashboard.
 */
router.get('/summary', async (req: Request, res: Response) => {
  try {
    const data = await aggregateDashboardData();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

/**
 * GET /dashboard/predictions
 * Returns recent predictions (cached).
 */
router.get('/predictions', async (_req: Request, res: Response) => {
  try {
    const predictions = await getRecentPredictions();
    res.json(predictions);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Unknown error' });
  }
});

/**
 * POST /dashboard/alerts
 * Accepts a new alert payload and forwards it to the alerts service.
 */
router.post('/alerts', express.json(), async (req: Request, res: Response) => {
  const alertPayload = req.body;
  if (!alertPayload || typeof alertPayload !== 'object') {
    res.status(400).json({ error: 'Invalid alert payload' });
    return;
  }

  try {
    const response = await axios.post(ALERTS_SERVICE_URL, alertPayload, { timeout: 5000 });
    res.status(201).json(response.data);
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to forward alert' });
  }
});

// ---------- WebSocket Multiplexing ----------
/**
 * Multiplexed WebSocket server.
 * Clients send JSON messages:
 *   { "type": "subscribe", "channel": "alerts" }
 *   { "type": "unsubscribe", "channel": "alerts" }
 *
 * Server broadcasts messages with shape:
 *   { "channel": "alerts", "payload": {...} }
 */
export class DashboardWebSocket {
  private wss: WebSocketServer;
  private channelClients: Map<string, Set<WebSocket>> = new Map();
  private alertEmitter: EventEmitter = new EventEmitter();

  constructor(server: HttpServer) {
    this.wss = new WebSocketServer({ server, path: '/ws/dashboard' });
    this.setupConnectionHandler();
    this.setupAlertForwarding();
  }

  /**
   * Handles incoming client connections.
   */
  private setupConnectionHandler(): void {
    this.wss.on('connection', (ws: WebSocket, req) => {
      // Optional: authenticate the WebSocket connection using JWT query param
      const url = new URL(req.url ?? '', `http://${req.headers.host}`);
      const token = url.searchParams.get('token');
      if (!token) {
        ws.close(4001, 'Missing token