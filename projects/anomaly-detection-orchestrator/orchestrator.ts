import express, { Request, Response, NextFunction } from 'express';
import { createServer as createHttpServer } from 'http';
import { Server as WebSocketServer, WebSocket } from 'ws';
import jwt, { JwtPayload } from 'jsonwebtoken';
import Redis from 'ioredis';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import crypto from 'crypto';
import { URLSearchParams } from 'url';

// ---------- Configuration ----------
const JWT_SECRET = process.env.JWT_SECRET ?? 'change_this_secret';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const HTTP_PORT = Number(process.env.HTTP_PORT) || 3000;
const WS_PORT = Number(process.env.WS_PORT) || 3001;
const RATE_LIMIT_POINTS = Number(process.env.RATE_LIMIT_POINTS) || 20; // requests
const RATE_LIMIT_DURATION = Number(process.env.RATE_LIMIT_DURATION) || 60; // seconds
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS) || 300; // 5 minutes

// ---------- Types ----------
type Algorithm = 'STL' | 'Kalman';

interface TimeSeriesPayload {
  clientId: string;
  timestamps: string[]; // ISO strings
  values: number[];
  metadata: {
    algorithm: Algorithm;
    [key: string]: any;
  };
}

interface AnomalyResult {
  anomalies: number[]; // indices of anomalous points
  algorithm: Algorithm;
}

// ---------- Helper Functions ----------
function validatePayload(body: any): TimeSeriesPayload {
  if (typeof body !== 'object' || body === null) {
    throw new Error('Payload must be a JSON object');
  }
  const { clientId, timestamps, values, metadata } = body;
  if (typeof clientId !== 'string' || clientId.trim() === '') {
    throw new Error('clientId must be a non‑empty string');
  }
  if (!Array.isArray(timestamps) || timestamps.length !== values?.length) {
    throw new Error('timestamps must be an array with same length as values');
  }
  if (!Array.isArray(values) || values.some((v) => typeof v !== 'number')) {
    throw new Error('values must be an array of numbers');
  }
  if (typeof metadata !== 'object' || metadata === null) {
    throw new Error('metadata must be an object');
  }
  if (!['STL', 'Kalman'].includes(metadata.algorithm)) {
    throw new Error('metadata.algorithm must be either "STL" or "Kalman"');
  }
  return { clientId, timestamps, values, metadata };
}

/**
 * Simple STL‑like anomaly detection.
 * For demonstration we compute a rolling median and flag points deviating
 * more than 3 * MAD (median absolute deviation).
 *
 * Formula:
 *   MAD = median(|x_i - median(x)|)
 *   threshold = median(x) ± 3 * MAD
 */
function detectAnomaliesSTL(values: number[]): number[] {
  const window = Math.min(7, values.length);
  const anomalies: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const start = Math.max(0, i - Math.floor(window / 2));
    const end = Math.min(values.length, i + Math.floor(window / 2) + 1);
    const slice = values.slice(start, end);
    const median = slice[Math.floor(slice.length / 2)];
    const mad = medianAbsoluteDeviation(slice, median);
    const lower = median - 3 * mad;
    const upper = median + 3 * mad;
    if (values[i] < lower || values[i] > upper) {
      anomalies.push(i);
    }
  }
  return anomalies;
}

/**
 * Simple Kalman filter based anomaly detection.
 * We use a 1‑D constant‑velocity model.
 *
 * Prediction:
 *   x̂ₖ|ₖ₋₁ = x̂ₖ₋₁
 *   Pₖ|ₖ₋₁ = Pₖ₋₁ + Q
 *
 * Update:
 *   Kₖ = Pₖ|ₖ₋₁ / (Pₖ|ₖ₋₁ + R)
 *   x̂ₖ = x̂ₖ|ₖ₋₁ + Kₖ (zₖ - x̂ₖ|ₖ₋₁)
 *   Pₖ = (1 - Kₖ) Pₖ|ₖ₋₁
 *
 * Anomaly if |zₖ - x̂ₖ| > 3 * sqrt(Pₖ)
 */
function detectAnomaliesKalman(values: number[]): number[] {
  const Q = 1e-5; // process noise
  const R = 0.01; // measurement noise
  let xHat = values[0];
  let P = 1;
  const anomalies: number[] = [];

  for (let k = 0; k < values.length; k++) {
    // Predict
    const xPred = xHat;
    const PPred = P + Q;

    // Update
    const K = PPred / (PPred + R);
    const innovation = values[k] - xPred;
    xHat = xPred + K * innovation;
    P = (1 - K) * PPred;

    const sigma = Math.sqrt(P);
    if (Math.abs(innovation) > 3 * sigma) {
      anomalies.push(k);
    }
  }
  return anomalies;
}

/**
 * Compute Median Absolute Deviation.
 */
function medianAbsoluteDeviation(arr: number[], median: number): number {
  const deviations = arr.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mid = Math.floor(deviations.length / 2);
  return deviations.length % 2 === 0
    ? (deviations[mid - 1] + deviations[mid]) / 2
    : deviations[mid];
}

/**
 * Generate a deterministic hash for caching.
 */
function hashPayload(payload: TimeSeriesPayload): string {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(payload));
  return hash.digest('hex');
}

// ---------- Core Service ----------
export class OrchestratorService {
  private app = express();
  private httpServer = createHttpServer(this.app);
  private wsServer: WebSocketServer;
  private redis: Redis.Redis;
  private rateLimiter: RateLimiterMemory;
  private wsClients: Map<string, Set<WebSocket>> = new Map(); // clientId -> sockets

  constructor() {
    this.redis = new Redis(REDIS_URL);
    this.rateLimiter = new RateLimiterMemory({
      points: RATE_LIMIT_POINTS,
      duration: RATE_LIMIT_DURATION,
    });
    this.wsServer = new WebSocketServer({ port: WS_PORT });
    this.configureMiddleware();
    this.configureRoutes();
    this.configureWebSocket();
  }

  private configureMiddleware() {
    this.app.use(express.json());

    // JWT authentication middleware
    this.app.use((req: Request, res: Response, next: NextFunction