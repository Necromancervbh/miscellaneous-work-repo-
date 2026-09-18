import http from 'http';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { Server as WebSocketServer, WebSocket } from 'ws';
import rateLimit from 'express-rate-limit';
import LRUCache from 'lru-cache';
import { EventEmitter } from 'events';

// ---------- Configuration ----------
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const WS_PATH = '/ws/anomalies';
const MAX_CACHE_ITEMS = 500;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const WS_MESSAGE_RATE_LIMIT = 5; // messages per second per client

// ---------- LRU Cache ----------
type AnomalyScore = {
  timestamp: number; // epoch ms
  score: number;
  details?: any;
};

const anomalyCache = new LRUCache<string, AnomalyScore>({
  max: MAX_CACHE_ITEMS,
  ttl: CACHE_TTL_MS,
});

// ---------- Express App ----------
const app = express();

app.use(cors());
app.use(bodyParser.json());

// ---------- Rate Limiter for HTTP ----------
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'Too many requests, please try again later.' });
  },
});

app.use('/api/', apiLimiter);

// ---------- JWT Authentication Middleware ----------
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

// ---------- Health Check ----------
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// ---------- Receive Anomaly Scores ----------
app.post('/api/anomaly', authenticateJWT, (req: AuthenticatedRequest, res: Response) => {
  const { timestamp, score, details } = req.body as Partial<AnomalyScore>;

  // Input validation
  if (typeof timestamp !== 'number' || typeof score !== 'number') {
    return res.status(400).json({ error: 'Invalid payload: timestamp and score are required numbers.' });
  }

  const anomaly: AnomalyScore = {
    timestamp,
    score,
    details: details ?? null,
  };

  // Store in LRU cache
  const cacheKey = timestamp.toString();
  anomalyCache.set(cacheKey, anomaly);

  // Emit to WebSocket listeners
  orchestratorEmitter.emit('anomaly', anomaly);

  res.status(201).json({ message: 'Anomaly score received.', id: cacheKey });
});

// ---------- Retrieve Recent Anomalies ----------
app.get('/api/anomalies/recent', authenticateJWT, (req: AuthenticatedRequest, res: Response) => {
  const recent = anomalyCache.values();
  res.json({ count: recent.length, anomalies: Array.from(recent) });
});

// ---------- Orchestrator Event Emitter ----------
const orchestratorEmitter = new EventEmitter();

// ---------- HTTP Server ----------
const server = http.createServer(app);

// ---------- WebSocket Server ----------
const wss = new WebSocketServer({ server, path: WS_PATH });

interface ClientInfo {
  socket: WebSocket;
  lastMessageTimestamps: number[]; // epoch ms of recent messages
}

/**
 * Checks if a client exceeds the allowed message rate.
 * Uses a sliding window of 1 second.
 * @param timestamps Array of previous message timestamps.
 * @returns true if within limit, false otherwise.
 */
function isWithinRateLimit(timestamps: number[]): boolean {
  const now = Date.now();
  const windowStart = now - 1000; // 1 second window
  const recent = timestamps.filter((t) => t >= windowStart);
  return recent.length < WS_MESSAGE_RATE_LIMIT;
}

// Map to store client info for rate limiting
const clients = new Map<string, ClientInfo>();

wss.on('connection', (ws: WebSocket, request) => {
  // Extract token from query string: ws://host/ws/anomalies?token=...
  const url = new URL(request.url ?? '', `http://${request.headers.host}`);
  const token = url.searchParams.get('token');

  if (!token) {
    ws.close(4001, 'Missing token');
    return;
  }

  // Verify JWT
  try {
    jwt.verify(token, JWT_SECRET);
  } catch (err) {
    ws.close(4002, 'Invalid token');
    return;
  }

  const clientId = `${request.socket.remoteAddress}:${request.socket.remotePort}`;
  clients.set(clientId, { socket: ws, lastMessageTimestamps: [] });

  // Send recent cached anomalies on connect
  const recent = anomalyCache.values();
  ws.send(JSON.stringify({ type: 'init', anomalies: Array.from(recent) }));

  // Listener for new anomalies
  const anomalyListener = (anomaly: AnomalyScore) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'anomaly', data: anomaly }));
    }
  };
  orchestratorEmitter.on('anomaly', anomalyListener);

  // Handle incoming messages (e.g., ping)
  ws.on('message', (data) => {
    const clientInfo = clients.get(clientId);
    if (!clientInfo) return;

    const now = Date.now();
    clientInfo.lastMessageTimestamps = clientInfo.lastMessageTimestamps.filter(
      (t) => now - t < 1000
    );
    clientInfo.lastMessageTimestamps.push(now);

    if (!isWithinRateLimit(clientInfo.lastMessageT