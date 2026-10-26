import WebSocket, { Server as WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import jwt from 'jsonwebtoken';
import DBSCAN from 'ml-dbscan';
import Bottleneck from 'bottleneck';
import { URL } from 'url';

/**
 * Interface representing a raw anomaly event.
 */
export interface Anomaly {
  /** Unix epoch in milliseconds */
  timestamp: number;
  /** Identifier of the metric the anomaly belongs to */
  metric: string;
  /** Measured value that triggered the anomaly */
  value: number;
}

/**
 * Interface representing a smoothed data point after Kalman filtering.
 */
interface SmoothedPoint {
  metric: string;
  timestamp: number;
  value: number;
}

/**
 * Simple 1‑dimensional Kalman filter.
 *
 * Equations:
 *   Predict:   x̂ₖ⁻ = x̂ₖ₋₁
 *              Pₖ⁻ = Pₖ₋₁ + q
 *   Update:    Kₖ = Pₖ⁻ / (Pₖ⁻ + r)
 *              x̂ₖ = x̂ₖ⁻ + Kₖ (zₖ - x̂ₖ⁻)
 *              Pₖ = (1 - Kₖ) Pₖ⁻
 *
 * where:
 *   q – process (model) variance
 *   r – measurement variance
 *   x̂ – estimated state
 *   P – estimation error covariance
 *   K – Kalman gain
 */
class KalmanFilter1D {
  private q: number; // process variance
  private r: number; // measurement variance
  private x: number; // estimated value
  private p: number; // estimation error covariance
  private k: number; // Kalman gain

  /**
   * @param initialValue Starting estimate for the state.
   * @param q Process variance (default 1e-5).
   * @param r Measurement variance (default 0.01).
   */
  constructor(initialValue: number, q = 1e-5, r = 0.01) {
    if (typeof initialValue !== 'number' || isNaN(initialValue)) {
      throw new Error('KalmanFilter1D: initialValue must be a valid number');
    }
    this.q = q;
    this.r = r;
    this.x = initialValue;
    this.p = 1;
    this.k = 0;
  }

  /**
   * Incorporates a new measurement and returns the filtered estimate.
   * @param z New measurement.
   */
  public filter(z: number): number {
    if (typeof z !== 'number' || isNaN(z)) {
      throw new Error('KalmanFilter1D: measurement must be a valid number');
    }

    // Predict step
    const pPrior = this.p + this.q;

    // Update step
    this.k = pPrior / (pPrior + this.r);
    this.x = this.x + this.k * (z - this.x);
    this.p = (1 - this.k) * pPrior;

    return this.x;
  }
}

/**
 * Configuration options for the AlertEngine.
 */
export interface AlertEngineOptions {
  /** Port on which the WebSocket server will listen. */
  wsPort: number;
  /** Secret used to verify JWT tokens. */
  jwtSecret: string;
  /** Maximum number of alerts per second per client. */
  rateLimitPerSec: number;
  /** DBSCAN epsilon (neighbourhood radius). */
  dbscanEps?: number;
  /** DBSCAN minimum points to form a cluster. */
  dbscanMinPts?: number;
  /** Time window (ms) for which raw anomalies are kept before clustering. */
  windowMs?: number;
}

/**
 * Main class handling ingestion, smoothing, clustering and notification.
 */
export class AlertEngine {
  private wsServer: WebSocketServer;
  private jwtSecret: string;
  private rateLimitPerSec: number;
  private dbscanEps: number;
  private dbscanMinPts: number;
  private windowMs: number;

  // Kalman filters per metric
  private filters: Map<string, KalmanFilter1D> = new Map();

  // Sliding window of recent smoothed points
  private recentPoints: SmoothedPoint[] = [];

  // Per‑client rate limiters
  private clientLimiters: Map<WebSocket, Bottleneck> = new Map();

  // Periodic clustering timer
  private clusteringTimer: NodeJS.Timeout;

  /**
   * Constructs the engine and starts the WebSocket server.
   */
  constructor(opts: AlertEngineOptions) {
    if (!Number.isInteger(opts.wsPort) || opts.wsPort <= 0) {
      throw new Error('AlertEngine: wsPort must be a positive integer');
    }
    if (typeof opts.jwtSecret !== 'string' || opts.jwtSecret.length === 0) {
      throw new Error('AlertEngine: jwtSecret must be a non‑empty string');
    }
    if (typeof opts.rateLimitPerSec !== 'number' || opts