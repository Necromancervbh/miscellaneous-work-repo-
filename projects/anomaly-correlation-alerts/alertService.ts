import { Server as WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import * as jwt from 'jsonwebtoken';
import { EventEmitter } from 'events';
import { URL } from 'url';

/**
 * Simple Kalman Filter for 1-D signal smoothing.
 *
 * Predict step:
 *   x̂ₖ₋ = x̂ₖ₋₁
 *   Pₖ₋ = Pₖ₋₁ + Q
 *
 * Update step:
 *   Kₖ = Pₖ₋ / (Pₖ₋ + R)
 *   x̂ₖ = x̂ₖ₋ + Kₖ (zₖ - x̂ₖ₋)
 *   Pₖ = (1 - Kₖ) Pₖ₋
 *
 * where:
 *   x̂ₖ   = posterior estimate
 *   Pₖ   = posterior error covariance
 *   Q    = process variance (model noise)
 *   R    = measurement variance (sensor noise)
 *   Kₖ   = Kalman gain
 */
class KalmanFilter1D {
  private estimate: number;
  private errorCovariance: number;
  private readonly processVariance: number;
  private readonly measurementVariance: number;

  constructor(initialEstimate: number, initialErrorCovariance: number, processVariance: number, measurementVariance: number) {
    if (processVariance <= 0 || measurementVariance <= 0) {
      throw new Error('Process and measurement variances must be positive numbers.');
    }
    this.estimate = initialEstimate;
    this.errorCovariance = initialErrorCovariance;
    this.processVariance = processVariance;
    this.measurementVariance = measurementVariance;
  }

  /**
   * Incorporate a new measurement and return the filtered value.
   * @param measurement New observed value.
   */
  public filter(measurement: number): number {
    // Predict
    const priorEstimate = this.estimate;
    const priorErrorCovariance = this.errorCovariance + this.processVariance;

    // Update
    const kalmanGain = priorErrorCovariance / (priorErrorCovariance + this.measurementVariance);
    this.estimate = priorEstimate + kalmanGain * (measurement - priorEstimate);
    this.errorCovariance = (1 - kalmanGain) * priorErrorCovariance;

    return this.estimate;
  }
}

/**
 * Token bucket rate limiter.
 * Allows `maxTokens` events per `refillIntervalMs`. Tokens are replenished continuously.
 */
class RateLimiter {
  private readonly maxTokens: number;
  private readonly refillIntervalMs: number;
  private tokens: number;
  private lastRefill: number;

  constructor(maxTokens: number, refillIntervalMs: number) {
    if (maxTokens <= 0 || refillIntervalMs <= 0) {
      throw new Error('RateLimiter parameters must be positive numbers.');
    }
    this.maxTokens = maxTokens;
    this.refillIntervalMs = refillIntervalMs;
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  /**
   * Attempt to consume a token. Returns true if allowed, false otherwise.
   */
  public tryConsume(): boolean {
    this.refillTokens();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  private refillTokens(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    const tokensToAdd = (elapsed / this.refillIntervalMs) * this.maxTokens;
    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }
}

/**
 * Interface describing a connected client.
 */
interface ClientInfo {
  socket: WebSocket;
  userId: string;
  rateLimiter: RateLimiter;
}

/**
 * Core service handling anomaly ingestion, smoothing, detection, and alert broadcasting.
 */
export class AlertService extends EventEmitter {
  private readonly wss: WebSocketServer;
  private readonly clients: Map<string, ClientInfo> = new Map(); // key = socket id
  private readonly kalmanFilter: KalmanFilter1D;
  private readonly thresholdMultiplier: number;
  private readonly slidingWindowSize: number;
  private readonly recentValues: number[] = [];
  private readonly jwtSecret: string;

  /**
   * @param options Configuration options.
   *   - port: Port for the WebSocket server.
   *   - jwtSecret: Secret for verifying JWT tokens.
   *   - processVariance: Kalman filter process variance (Q).
   *   - measurementVariance: Kalman filter measurement variance (R).
   *   - thresholdMultiplier: Number of std deviations above mean to flag outlier.
   *   - slidingWindowSize: Number of recent filtered values to compute dynamic threshold.
   *   - maxAlertsPerSecond: Rate limit per client.
   */
  constructor(options: {
    port: number;
    jwtSecret: string;
    processVariance?: number;
    measurementVariance?: number;
    thresholdMultiplier?: number;
    slidingWindowSize?: number;
    maxAlertsPerSecond?: number;
  }) {
    super();

    const {
      port,
      jwtSecret,
      processVariance = 1e-3,
      measurementVariance = 1e-2,
      thresholdMultiplier = 3,
      slidingWindowSize = 50,
      maxAlertsPerSecond = 5,
    } = options;

    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error('Invalid port number.');
    }
    if (!jwtSecret) {
      throw new Error('JWT secret must be provided.');
    }

    this.jwtSecret = jwtSecret;
    this.kalmanFilter = new KalmanFilter1D(0, 1, processVariance, measurementVariance);
    this.thresholdMultiplier = thresholdMultiplier;
    this.slidingWindowSize = slidingWindowSize;

    const httpServer = http.createServer();
    this.wss = new WebSocketServer({ server: httpServer });

    httpServer.listen(port, () => {
      this.emit('listening', port);
    });

    this.wss.on('connection', (socket: WebSocket, request: http.IncomingMessage) => this.handleConnection(socket, request, maxAlertsPerSecond));
    this.wss.on('error', (err) => this.emit('error', err));
  }

  /**
   * Handles a new WebSocket connection, performing JWT authentication.
   */
  private handleConnection(socket: WebSocket, request: http.IncomingMessage, maxAlertsPerSecond: number): void {
    try {
      const url = new URL(request.url ?? '', `ws://${request.headers.host}`);
      const token = url.searchParams.get('token');
      if (!token) {
        socket.close(4001, 'Authentication token missing');
        return;
      }

      const payload = jwt.verify(token, this.jwtSecret) as { sub: string };
      if (!payload || typeof payload.sub !== 'string') {
        socket.close(4002, 'Invalid token payload');
        return;
      }

      const clientId = this.generateSocketId(socket);
      const clientInfo: ClientInfo = {
        socket,
        userId: payload.sub,
        rateLimiter: new RateLimiter(maxAlertsPerSecond, 1000),
      };
      this.clients.set(clientId, clientInfo);

      socket.on('close', () => {
        this.clients.delete(clientId);
      });

      socket.on('error', (err) => {
        this.emit('clientError', clientInfo.userId, err);
      });
    } catch (err) {
      socket.close(4003, 'Authentication failed');
    }
  }

  /**
   * Generates a deterministic identifier for a WebSocket instance.
   */
  private generateSocketId(socket: WebSocket): string {
    // Using the underlying socket