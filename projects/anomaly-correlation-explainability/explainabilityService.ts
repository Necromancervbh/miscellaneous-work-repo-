import express, { Request, Response, NextFunction, Router } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import Redis from 'ioredis';
import * as tf from '@tensorflow/tfjs-node';
import WebSocket, { Server as WebSocketServer } from 'ws';
import { param, validationResult } from 'express-validator';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Configuration
 */
const JWT_SECRET = process.env.JWT_SECRET ?? 'your_jwt_secret';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const MODEL_PATH = process.env.MODEL_PATH ?? './model/model.json';
const WS_PORT = Number(process.env.WS_PORT ?? 8081);
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS ?? 300); // 5 minutes

/**
 * Redis client – LRU eviction is configured on the Redis server side (maxmemory-policy allkeys-lru)
 */
const redis = new Redis(REDIS_URL);

/**
 * Load TensorFlow.js model once at startup.
 */
let model: tf.LayersModel;
(async () => {
  try {
    model = await tf.loadLayersModel(`file://${MODEL_PATH}`);
    console.log('Model loaded successfully.');
  } catch (err) {
    console.error('Failed to load model:', err);
    process.exit(1);
  }
})();

/**
 * WebSocket server for notifications.
 * Maintains a map of userId -> Set of WebSocket connections.
 */
class NotificationHub {
  private wss: WebSocketServer;
  private userSockets: Map<string, Set<WebSocket>> = new Map();

  constructor(port: number) {
    this.wss = new WebSocketServer({ port });
    this.wss.on('connection', (ws: WebSocket, req) => {
      const token = this.extractTokenFromQuery(req.url ?? '');
      if (!token) {
        ws.close(4001, 'Missing token');
        return;
      }
      let payload: any;
      try {
        payload = jwt.verify(token, JWT_SECRET);
      } catch {
        ws.close(4002, 'Invalid token');
        return;
      }
      const userId = payload.sub;
      if (!userId) {
        ws.close(4003, 'Missing subject in token');
        return;
      }
      if (!this.userSockets.has(userId)) {
        this.userSockets.set(userId, new Set());
      }
      this.userSockets.get(userId)!.add(ws);

      ws.on('close', () => {
        this.userSockets.get(userId)!.delete(ws);
        if (this.userSockets.get(userId)!.size === 0) {
          this.userSockets.delete(userId);
        }
      });
    });
    console.log(`WebSocket notification hub listening on port ${port}`);
  }

  private extractTokenFromQuery(url: string): string | null {
    const match = url.match(/[?&]token=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  public notify(userId: string, message: object): void {
    const sockets = this.userSockets.get(userId);
    if (!sockets) return;
    const payload = JSON.stringify(message);
    sockets.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    });
  }
}

const notificationHub = new NotificationHub(WS_PORT);

/**
 * Middleware: JWT authentication.
 */
function authenticateJWT(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header missing or malformed' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string };
    (req as any).userId = payload.sub;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid JWT token' });
  }
}

/**
 * Rate limiter: 60 requests per minute per IP.
 */
const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

/**
 * Helper: Validate request parameters.
 */
function validateRequest(req: Request, res: Response, next: NextFunction) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ error: 'Invalid request parameters', details: errors.array() });
  }
  next();
}

/**
 * Placeholder: Retrieve time‑series data for a given ID.
 * In a real implementation this would query a database or external service.
 */
async function fetchTimeSeriesData(timeSeriesId: string): Promise<tf.Tensor> {
  // For demonstration, generate a random tensor with 10 features.
  // Shape: [1, featureCount]
  const featureCount = 10;
  const data = tf.randomNormal([1, featureCount]);
  return data;
}

/**
 * Compute SHAP values using a simple Kernel SHAP approximation.
 * This is a lightweight implementation for demonstration purposes.
 *
 * @param model Trained TensorFlow.js model.
 * @param input Input tensor of shape [1, features].
 * @returns Array of feature contributions.
 */
async function computeShapValues(model: tf.LayersModel, input: tf.Tensor): Promise<number[]> {
  // Number of background samples for Kernel SHAP.
  const backgroundSamples = 50;
  const featureCount = input.shape[1];
  const shapValues = new Array<number>(featureCount).fill(0);

  // Generate background data (zeros) as a simple baseline.
  const baseline = tf.zerosLike(input);