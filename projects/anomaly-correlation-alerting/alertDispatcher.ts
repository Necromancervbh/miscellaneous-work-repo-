import http from 'http';
import { Server as WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { EventEmitter } from 'events';

/**
 * Types
 */
export interface Insight {
  /** Unique identifier of the insight */
  id: string;
  /** Metric name, e.g., "cpu_usage" */
  metric: string;
  /** Measured value */
  value: number;
  /** Timestamp in ISO format */
  timestamp: string;
  /** Additional payload */
  [key: string]: any;
}

export interface AlertPayload {
  /** Insight that triggered the alert */
  insight: Insight;
  /** Human‑readable message */
  message: string;
  /** Alert severity (e.g., "high", "critical") */
  severity: string;
  /** Server timestamp when alert was generated */
  generatedAt: string;
}

/** Configuration for thresholds per metric */
export interface ThresholdConfig {
  /** Metric name */
  metric: string;
  /** Threshold value – alert if insight.value >= threshold */
  threshold: number;
  /** Severity label to attach when threshold is crossed */
  severity: string;
}

/** Rate‑limit configuration per client */
export interface RateLimitConfig {
  /** Maximum number of alerts per interval */
  maxAlerts: number;
  /** Interval length in milliseconds */
  intervalMs: number;
}

/** Main dispatcher configuration */
export interface DispatcherConfig {
  /** JWT secret used for signing alerts */
  jwtSecret: string;
  /** JWT expiration time (e.g., "1h", "30m") */
  jwtExpiresIn?: string;
  /** Threshold definitions */
  thresholds: ThresholdConfig[];
  /** Rate‑limit defaults applied to every client */
  rateLimit: RateLimitConfig;
}

/**
 * Internal per‑client rate‑limit state
 */
interface ClientRateState {
  /** Timestamp of the start of the current window */
  windowStart: number;
  /** Number of alerts sent in the current window */
  alertsSent: number;
}

/**
 * AlertDispatcher
 *
 * Consumes Insight objects, evaluates them against configured thresholds,
 * and broadcasts JWT‑signed alerts over WebSocket connections while
 * respecting per‑client rate limits.
 */
export class AlertDispatcher extends EventEmitter {
  private wss: WebSocketServer;
  private config: DispatcherConfig;
  private clientRateMap: Map<WebSocket, ClientRateState> = new Map();

  /**
   * @param httpServer Existing HTTP server to attach the WS server to.
   * @param config Dispatcher configuration.
   */
  constructor(httpServer: http.Server, config: DispatcherConfig) {
    super();
    this.validateConfig(config);
    this.config = config;
    this.wss = new WebSocketServer({ server: httpServer });
    this.wss.on('connection', (ws) => this.handleConnection(ws));
    this.wss.on('error', (err) => this.emit('error', err));
  }

  /**
   * Validate dispatcher configuration.
   * Throws TypeError if validation fails.
   */
  private validateConfig(config: DispatcherConfig): void {
    if (typeof config.jwtSecret !== 'string' || config.jwtSecret.length === 0) {
      throw new TypeError('jwtSecret must be a non‑empty string');
    }
    if (!Array.isArray(config.thresholds) || config.thresholds.length === 0) {
      throw new TypeError('thresholds must be a non‑empty array');
    }
    for (const th of config.thresholds) {
      if (typeof th.metric !== 'string' || th.metric.length === 0) {
        throw new TypeError('Each threshold must have a non‑empty metric string');
      }
      if (typeof th.threshold !== 'number' || isNaN(th.threshold)) {
        throw new TypeError(`Threshold for metric ${th.metric} must be a valid number`);
      }
      if (typeof th.severity !== 'string' || th.severity.length === 0) {
        throw new TypeError('Each threshold must have a non‑empty severity string');
      }
    }
    const rl = config.rateLimit;
    if (
      typeof rl.maxAlerts !== 'number' ||
      rl.maxAlerts <= 0 ||
      !Number.isInteger(rl.maxAlerts)
    ) {
      throw new TypeError('rateLimit.maxAlerts must be a positive integer');
    }
    if (
      typeof rl.intervalMs !== 'number' ||
      rl.intervalMs <= 0 ||
      !Number.isInteger(rl.intervalMs)
    ) {
      throw new TypeError('rateLimit.intervalMs must be a positive integer (ms)');
    }
  }

  /**
   * Handle a new WebSocket client connection.
   */
  private handleConnection(ws: WebSocket): void {
    // Initialize rate‑limit state for the client
    this.clientRateMap.set(ws, {
      windowStart: Date.now(),
      alertsSent: 0,
    });

    ws.on('close', () => {
      this.clientRateMap.delete(ws);
    });

    ws.on('error', (err) => {
      this.emit('clientError', ws, err);
    });
  }

  /**
   * Public method to process an incoming insight.
   * If the insight exceeds a configured threshold, an alert is generated
   * and dispatched to all connected clients respecting rate limits.
   *
   * @param insight Insight object to evaluate.
   */
  public dispatchInsight(insight: Insight): void {
    try {
      this.validateInsight(insight);
    } catch (e) {
      this.emit('error', e);
      return;
    }

    const matchingThreshold = this.config.thresholds.find(
      (t) => t.metric === insight.metric && insight.value >= t.threshold
    );

    if (!matchingThreshold) {
      // No alert needed
      return;
    }

    const alertPayload: AlertPayload = {
      insight,
      message: `Threshold breached for ${insight.metric}: ${insight.value} >= ${matchingThreshold.threshold}`,
      severity: matchingThreshold.severity,
      generatedAt: new Date().toISOString(),
    };

    let token: string;
    try {
      token = jwt.sign(alertPayload, this.config.jwtSecret, {
        expiresIn: this.config.jwtExpiresIn ?? '1h',
        algorithm: 'HS256',
      });
    } catch (signErr) {
      this.emit('error', new Error(`JWT signing failed: ${signErr instanceof Error ? signErr.message : signErr}`));
      return;
    }

    const message = JSON.stringify({ token });

    // Broadcast to all clients respecting per‑client rate limits
    this.wss.clients.forEach((client) => {
      if (client.readyState !== WebSocket.OPEN) return;

      const rateState = this.clientRateMap.get(client);
      if (!rateState) return; // Should not happen

      const now = Date.now();
      // Reset window if interval elapsed
      if (now - rateState.windowStart >= this.config.rateLimit.intervalMs) {
        rateState.windowStart = now;
        rateState.alertsSent = 0;
      }

      if (rateState.alertsSent < this.config.rateLimit.maxAlerts) {
        try {
          client.send(message);
          rateState.alertsSent += 1;
        } catch (sendErr) {
          this.emit('clientError', client, sendErr);
        }
      } else {
        // Rate limit exceeded – optionally could queue or drop
        this.emit('rateLimitExceeded', client, alertPayload);
      }
    });
  }

  /**
   * Validate the structure of an Insight object.
   * Throws TypeError if validation fails.
   */
  private validateInsight(insight: Insight): void {
    if (typeof insight !== 'object' || insight === null) {
      throw new TypeError('Insight must be a non‑null object');
    }
    if (typeof insight.id !== 'string' || insight.id.length === 0) {
      throw new TypeError('Insight.id must be a non‑empty string');
    }
    if (typeof insight.metric !== 'string' || insight.metric.length === 0) {
      throw new TypeError('Insight.metric must be a non‑empty string');
    }
    if (typeof insight.value !== 'number' || isNaN(insight.value