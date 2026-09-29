// dashboardServer.js

'use strict';

// Core modules
const http = require('http');
const path = require('path');

// Third‑party modules
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const LRU = require('lru-cache');
const { Server: WebSocketServer } = require('ws');

// Configuration (use environment variables where possible)
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 30; // max 30 requests per window per IP
const METRICS_BROADCAST_INTERVAL_MS = 5000; // 5 seconds
const LRU_MAX_ITEMS = 1000; // max cached metric entries
const LRU_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

// Initialize Express app
const app = express();
app.use(cors());
app.use(bodyParser.json());

// ---------- LRU Cache for recent anomaly metrics ----------
/**
 * Cache stores objects:
 * {
 *   timestamp: Number (epoch ms),
 *   data: Object (aggregated metrics)
 * }
 */
const metricsCache = new LRU({
  max: LRU_MAX_ITEMS,
  ttl: LRU_MAX_AGE_MS,
  updateAgeOnGet: true,
});

// ---------- JWT Authentication Middleware ----------
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'Authorization header missing' });
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Bearer token missing' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user; // Attach decoded payload
    next();
  });
}

// ---------- Simple Login Endpoint (for demo) ----------
app.post('/login', (req, res) => {
  const { username, password } = req.body;

  // Basic validation
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Invalid username or password format' });
  }

  // In production, verify credentials against a user store.
  // Here we accept any non‑empty credentials for demonstration.
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const payload = { sub: username };
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  res.json({ token });
});

// ---------- Rate‑Limited Alert Endpoint ----------
const alertLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many alerts sent, please try again later' },
});

app.post('/alerts', alertLimiter, authenticateToken, (req, res) => {
  const { type, message, severity } = req.body;

  // Input validation
  if (typeof type !== 'string' || typeof message !== 'string' || typeof severity !== 'string') {
    return res.status(400).json({ error: 'Invalid alert payload' });
  }

  // In a real system, forward the alert to a notification service.
  // Here we simply acknowledge receipt.
  console.log(`[ALERT] User:${req.user.sub} Type:${type} Severity:${severity} Message:${message}`);

  res.json({ status: 'Alert received' });
});

// ---------- Endpoint to Retrieve Recent Cached Metrics ----------
app.get('/metrics/recent', authenticateToken, (req, res) => {
  const recent = metricsCache.values().sort((a, b) => a.timestamp - b.timestamp);
  res.json({ metrics: recent });
});

// ---------- WebSocket Server with Multiplexed Channels ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/**
 * Protocol:
 * Client -> Server:
 *   { type: 'subscribe', channel: 'metrics' }
 *   { type: 'unsubscribe', channel: 'metrics' }
 *
 * Server -> Client:
 *   { type: 'data', channel: 'metrics', payload: {...} }
 */

const CHANNELS = {
  METRICS: 'metrics',
};

function isValidChannel(channel) {
  return Object.values(CHANNELS).includes(channel);
}

// Maintain a map of channel -> Set of WebSocket clients
const channelSubscriptions = new Map();

wss.on('connection', (ws, req) => {
  // Simple token check on connection (optional)
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  if (!token) {
    ws.close(4001, 'Missing token');
    return;
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      ws.close(4002, 'Invalid token');
      return;
    }
    ws.user = user; // Attach user info for later use if needed
  });

  ws.on('message', (message) => {
    let msgObj;
    try {
      msgObj = JSON.parse(message);
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
      return;
    }

    if (msgObj.type === 'subscribe') {
      if (!isValidChannel(msgObj.channel)) {
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid channel' }));
        return;
      }
      let set = channelSubscriptions.get(msgObj.channel);
      if (!set) {
        set = new Set();
        channelSubscriptions.set(msgObj.channel, set);
      }
      set.add(ws);
      ws.send(JSON.stringify({ type: 'subscribed', channel: msgObj.channel }));
    } else if (msgObj.type === 'unsubscribe') {
      if (!isValidChannel(msgObj.channel)) {
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid channel' }));
        return;
      }
      const set = channelSubscriptions.get(msgObj.channel);
      if (set) {
        set.delete(ws);
      }
      ws.send(JSON.stringify({ type: 'unsubscribed', channel: msgObj.channel }));
    } else {
      ws.send(JSON.stringify({ type: 'error', error: 'Unsupported message type' }));
    }
  });

  ws.on('close', () => {
    // Clean up subscriptions
    for (const set of channelSubscriptions.values()) {
      set.delete(ws);
    }
  });
});

// ---------- Simulated Aggregated Anomaly Metrics ----------
/**
 * For demonstration, generate a random metric object.
 * In production, replace this with real aggregation logic.
 *
 * Formula (example):
 *   anomalyScore = Σ_i (weight_i * deviation_i)   // Σ denotes sum over i
 */
function generateAnomalyMetric() {
  const timestamp = Date.now();
  const metric = {
    timestamp,
    anomalyScore: parseFloat((Math.random() * 100).toFixed(2)),
    affectedSources: Math.floor(Math.random() * 10) + 1,
    severity: ['low', 'medium', 'high'][Math.floor(Math.random() * 3)],
    details