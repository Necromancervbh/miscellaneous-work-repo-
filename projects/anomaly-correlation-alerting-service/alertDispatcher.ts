import { EventEmitter } from 'events';
import { createServer, Server as HttpServer } from 'http';
import WebSocket, { WebSocketServer, WebSocket as WSClient } from 'ws';
import LRUCache from 'lru-cache';

/**
 * Interface representing a correlation score emitted by the orchestrator.
 */
export interface CorrelationScore {
  /** Unique identifier of the score event (e.g., UUID). */
  id: string;
  /** Numeric correlation score (e.g., 0.0 – 1.0). */
  score: number;
  /** Type/category of the correlation (used for threshold lookup). */
  type: string;
  /** ISO‑8601 timestamp of when the score was generated. */
  timestamp: string;
  /** Arbitrary payload containing additional context. */
  details?: Record<string, unknown>;
}

/**
 * Configuration options for the AlertDispatcher.
 */
export interface AlertDispatcherConfig {
  /** Mapping from correlation type to the minimum score required to raise an alert. */
  thresholds: Record<string, number>;
  /** Maximum number of recent alerts to keep for de‑duplication. */
  cacheSize: number;
  /** Port on which the WebSocket server will listen. */
  wsPort: number;
  /** Optional HTTP server (useful for integration with existing servers). */
  httpServer?: HttpServer;
}

/**
 * Alert message sent to subscribed WebSocket clients.
 */
export interface AlertMessage {
  /** CorrelationScore that triggered the alert. */
  score: CorrelationScore;
  /** Human‑readable message. */
  message: string;
}

/**
 * Service that consumes correlation scores, applies thresholds, de‑duplicates alerts,
 * and publishes them via WebSocket.
 */
export class AlertDispatcher extends EventEmitter {
  private readonly thresholds: Record<string, number>;
  private readonly cache: LRUCache<string, true>;
  private readonly wss: WebSocketServer;
  private readonly clients: Set<WSClient> = new Set();

  /**
   * Constructs a new AlertDispatcher.
   * @param config Configuration object.
   * @throws Error if validation fails.
   */
  constructor(private readonly config: AlertDispatcherConfig) {
    super();
    this.validateConfig(config);
    this.thresholds = { ...config.thresholds };
    this.cache = new LRUCache<string, true>({ max: config.cacheSize });

    // Initialise WebSocket server (reuse provided HTTP server if any)
    this.wss = new WebSocketServer({
      port: config.wsPort,
      server: config.httpServer,
    });

    this.wss.on('connection', (ws: WSClient) => this.handleConnection(ws));
    this.wss.on('error', (err) => this.emit('error', err));
  }

  /**
   * Validates the configuration object.
   * @param cfg Configuration to validate.
   * @throws Error if any required field is missing or malformed.
   */
  private validateConfig(cfg: AlertDispatcherConfig): void {
    if (!cfg) {
      throw new Error('Configuration object is required.');
    }
    if (typeof cfg.wsPort !== 'number' || cfg.wsPort <= 0 || cfg.wsPort > 65535) {
      throw new Error('wsPort must be a valid TCP port number.');
    }
    if (!cfg.thresholds || typeof cfg.thresholds !== 'object') {
      throw new Error('thresholds must be a non‑empty object mapping types to numbers.');
    }
    for (const [type, value] of Object.entries(cfg.thresholds)) {
      if (typeof value !== 'number' || isNaN(value)) {
        throw new Error(`Threshold for type "${type}" must be a valid number.`);
      }
    }
    if (typeof cfg.cacheSize !== 'number' || cfg.cacheSize <= 0) {
      throw new Error('cacheSize must be a positive integer.');
    }
  }

  /**
   * Handles a new WebSocket client connection.
   * @param ws The connected client.
   */
  private handleConnection(ws: WSClient): void {
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', (err) => this.emit('clientError', err));
  }

  /**
   * Consumes a correlation score from the orchestrator.
   * Performs validation, threshold check, de‑duplication, and dispatch.
   * @param score The incoming correlation score.
   */
  public async dispatchScore(score: CorrelationScore): Promise<void> {
    try {
      this.validateScore(score);
    } catch (err) {
      this.emit('error', err);
      return;
    }

    // De‑duplication: skip if already processed
    if (this.cache.has(score.id)) {
      return;
    }

    // Threshold evaluation:
    // Alert is raised if score >= threshold(type)
    //   score >= thresholds[type]
    const threshold = this.thresholds[score.type];
    if (threshold === undefined) {
      // No configured threshold for this type → ignore
      return;
    }

    if (score.score >= threshold) {
      const alertMsg: AlertMessage = {
        score,
        message: `Alert: ${score.type} scored ${score.score.toFixed(3)} (threshold ${threshold})`,
      };
      this.broadcastAlert(alertMsg);
      this.cache.set(score.id, true);
    }
  }

  /**
   * Validates the structure and values of a CorrelationScore.
   * @param score Score to validate.
   * @throws Error if validation fails.
   */
  private validateScore(score: CorrelationScore): void {
    if (!score || typeof score !== 'object') {
      throw new Error('CorrelationScore must be an object.');
    }
    if (typeof score.id !== 'string' || score.id.trim() === '') {
      throw new Error('CorrelationScore.id must be a non‑empty string.');
    }
    if (typeof score.type !== 'string' || score.type.trim() === '') {
      throw new Error('CorrelationScore.type must be a non‑empty string.');
    }
    if (typeof score.score !== 'number' || isNaN(score.score)) {
      throw new Error('CorrelationScore.score must be a valid number.');
    }
    if (typeof score.timestamp !== 'string' || isNaN(Date.parse(score.timestamp))) {
      throw new Error('CorrelationScore.timestamp must be a valid ISO‑8601 string.');
    }
    // details is optional; no validation needed
  }

  /**
   * Broadcasts an alert to all connected WebSocket clients.
   * @param alert AlertMessage to send.
   */
  private broadcastAlert(alert: AlertMessage): void {
    const payload = JSON.stringify(alert);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload, (err) => {
          if (err) {
            this.emit('clientError', err);
          }
        });
      }
    }
  }

  /**
   * Gracefully shuts down the dispatcher, closing all client connections
   * and the underlying WebSocket server.
   * @returns Promise that resolves when shutdown completes.
   */
  public async shutdown(): Promise<void> {
    // Close all client sockets
    for (const client of this.clients) {
      try {
        client.terminate();
      } catch {
        // ignore errors during termination
      }
    }
    this.clients.clear();

    // Close WebSocket server
    await new Promise<void>((resolve, reject) => {
      this.wss.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

/**
 * Example usage (commented out for library consumption):
 *
 * const dispatcher = new AlertDispatcher({
 *   wsPort: 8080,
 *   cacheSize: 1000,
 *   thresholds: { cpu: 0.8, memory: 0.75 },
 * });
 *
 * // Simulate incoming scores
 * dispatcher.dispatchScore({
 *   id: