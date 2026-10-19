import express, { Request, Response, NextFunction, Router } from 'express';
import { Server as HttpServer } from 'http';
import { Server as WebSocketServer, WebSocket } from 'ws';
import jwt, { JwtPayload } from 'jsonwebtoken';
import LRUCache from 'lru-cache';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { v4 as uuidv4 } from 'uuid';
import { predict } from './predictionEngine'; // Assume existing prediction engine
import { EventPayload, PredictionResult, AlertMessage } from './types';

// Configuration constants
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const RATE_LIMIT_POINTS = Number(process.env.RATE_LIMIT_POINTS) || 10; // requests
const RATE_LIMIT_DURATION = Number(process.env.RATE_LIMIT_DURATION) || 60; // seconds
const CACHE_MAX_ITEMS = Number(process.env.CACHE_MAX_ITEMS) || 1000;
const CACHE_MAX_AGE_MS = Number(process.env.CACHE_MAX_AGE_MS) || 5 * 60 * 1000; // 5 minutes

// LRU Cache for prediction results
// Cache key: `${userId}:${eventId}`
// Value: PredictionResult
const predictionCache = new LRUCache<string, PredictionResult>({
  max: CACHE_MAX_ITEMS,
  ttl: CACHE_MAX_AGE_MS,
});

// Rate limiter per user (in-memory)
const rateLimiter = new RateLimiterMemory({
  points: RATE_LIMIT_POINTS,
  duration: RATE_LIMIT_DURATION,
});

// WebSocket client registry per user
type ClientRegistry = Map<string, Set<WebSocket>>; // userId -> Set of sockets
const wsClients: ClientRegistry = new Map();

/**
 * Middleware to validate JWT and attach userId to request.
 */
function jwtAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
    if (!payload.sub) {
      throw new Error('JWT payload missing subject');
    }
    // Attach user identifier to request for downstream use
    (req as any).userId = payload.sub;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token', details: (err as Error).message });
  }
}

/**
 * Middleware to enforce per‑user rate limiting.
 */
async function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = (req as any).userId as string;
  try {
    await rateLimiter.consume(userId);
    next();
  } catch (rej) {
    res.status(429).json({ error: 'Rate limit exceeded' });
  }
}

/**
 * Validate incoming event payload.
 * Throws an Error if validation fails.
 */
function validateEventPayload(body: any): asserts body is EventPayload {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Payload must be a JSON object');
  }
  if (typeof body.eventId !== 'string' || body.eventId.trim() === '') {
    throw new Error('eventId must be a non‑empty string');
  }
  if (typeof body.timestamp !== 'string' || isNaN(Date.parse(body.timestamp))) {
    throw new Error('timestamp must be a valid ISO 8601 string');
  }
  if (typeof body.data !== 'object' || body.data === null) {
    throw new Error('data must be an object');
  }
}

/**
 * Core handler for ingestion events.
 */
async function handleIngestion(req: Request, res: Response): Promise<void> {
  const userId = (req as any).userId as string;
  try {
    validateEventPayload(req.body);
  } catch (validationError) {
    res.status(400).json({ error: (validationError as Error).message });
    return;
  }

  const event: EventPayload = req.body;
  const cacheKey = `${userId}:${event.eventId}`;

  // Return cached prediction if present
  const cached = predictionCache.get(cacheKey);
  if (cached) {
    res.json({ prediction: cached, cached: true });
    return;
  }

  // Trigger prediction engine
  let prediction: PredictionResult;
  try {
    prediction = await predict(event);
  } catch (engineError) {
    res.status(502).json({ error: 'Prediction engine failure', details: (engineError as Error).message });
    return;
  }

  // Store in cache
  predictionCache.set(cacheKey, prediction);

  // Publish alert if anomaly detected (example condition)
  if (prediction.anomalyScore !== undefined && prediction.anomalyScore > 0.8) {
    const alert: AlertMessage = {
      alertId: uuidv4(),
      userId,
      eventId: event.eventId,
      timestamp: new Date().toISOString(),
      severity: 'high',
      message: `Anomaly detected with score ${prediction.anomalyScore}`,
      payload: event,
    };
    broadcastAlert(userId, alert);
  }

  res.json({ prediction, cached: false });
}

/**
 * Broadcast an alert to all WebSocket clients belonging to a user.
 */
function broadcastAlert(userId: string, alert: AlertMessage): void {
  const clients = wsClients.get(userId);
  if (!clients) return;

  const payload = JSON.stringify({ type: 'alert', data: alert });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
    }
  }
}

/**
 * Initialize WebSocket server and attach connection handling.
 */
function initWebSocket(server: HttpServer): void {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: WebSocket, req) => {
    // Expect JWT token as query param: ?token=...
    const url = new URL(req.url ?? '', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');
    if (!token) {
      ws.close(4001, 'Missing token');
      return;
    }

    let payload: JwtPayload;
    try {
      payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
      if (!payload.sub) throw new Error('Missing subject');
    } catch (err) {
      ws.close(4002, 'Invalid token');
      return;
    }

    const userId = payload.sub as string;
    // Register client
    if (!wsClients.has(userId)) {
      wsClients.set(userId, new Set());
    }
    wsClients.get(userId)!.add(ws);

    ws.on('close', () => {
      wsClients.get(userId)!.delete(ws);
      if (wsClients.get(userId)!.size === 0) {
        wsClients.delete(userId);
      }
    });

    ws.on('error', () => {
      ws.close();
    });
  });
}

/**
 * Create and configure the Express router for ingestion endpoint.
 */
function createRouter(): Router {
  const router = Router();

  router.use(express.json({ limit: '1mb' }));
  router.use(jwtAuthMiddleware);
  router.use(rateLimitMiddleware);
  router.post('/ingest', handleIngestion);

  // Health check endpoint (no auth)
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  return router;
}

/**
 * Orchestrator initialization function.
 * Call this from your main server bootstrap file.
 *
 * @param app Express application instance.
 * @param httpServer Underlying HTTP server (required for WebSocket upgrade).
 */
export function initOrchestrator(app: express.Application, httpServer: HttpServer): void {
  // Attach router
  const router = createRouter();
  app.use('/api