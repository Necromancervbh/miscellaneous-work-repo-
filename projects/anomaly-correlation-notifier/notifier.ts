import { EventEmitter } from 'events';
import { Server as WebSocketServer, WebSocket } from 'ws';
import nodemailer, { Transporter } from 'nodemailer';
import PQueue from 'p-queue';
import { setTimeout as delay } from 'timers/promises';

/**
 * Represents a single anomaly event emitted by the orchestrator.
 */
export interface AnomalyEvent {
  /** Unique identifier for the anomaly */
  id: string;
  /** Correlation identifier used to group related anomalies */
  correlationId: string;
  /** Human readable description */
  description: string;
  /** Timestamp of the event (ISO string or number) */
  timestamp: string | number;
  /** Additional payload */
  payload?: Record<string, unknown>;
}

/**
 * Represents an aggregated alert generated from correlated anomalies.
 */
export interface Alert {
  /** Correlation identifier */
  correlationId: string;
  /** List of anomaly IDs that contributed to this alert */
  anomalyIds: string[];
  /** Concatenated description */
  summary: string;
  /** Timestamp when the alert was generated */
  generatedAt: Date;
}

/**
 * Configuration required to initialise the NotifierService.
 */
export interface NotifierConfig {
  /** Port for the WebSocket server */
  wsPort: number;
  /** SMTP configuration for nodemailer */
  smtp: {
    host: string;
    port: number;
    secure?: boolean;
    auth: {
      user: string;
      pass: string;
    };
    /** Optional from address */
    from?: string;
  };
  /** Email address to send alerts to */
  alertRecipient: string;
  /** Maximum number of alerts processed per interval */
  rateLimit: {
    /** Number of alerts allowed */
    intervalCap: number;
    /** Interval length in milliseconds */
    interval: number;
  };
  /** Time window (ms) to aggregate anomalies with the same correlationId */
  aggregationWindowMs: number;
}

/**
 * Service that consumes anomaly events, aggregates them, and dispatches alerts via
 * WebSocket and SMTP, respecting a rate‑limited async queue.
 */
export class NotifierService {
  private readonly config: NotifierConfig;
  private readonly wss: WebSocketServer;
  private readonly smtpTransport: Transporter;
  private readonly queue: PQueue;
  private readonly aggregationMap: Map<string, {
    anomalies: AnomalyEvent[];
    timer: NodeJS.Timeout;
  }> = new Map();

  /**
   * Initialise the service.
   * @param config Configuration object.
   */
  constructor(config: NotifierConfig) {
    this.validateConfig(config);
    this.config = config;

    // Initialise WebSocket server
    this.wss = new WebSocketServer({ port: config.wsPort });
    this.wss.on('connection', (ws: WebSocket) => {
      ws.on('error', (err) => console.error('WebSocket error:', err));
    });
    this.wss.on('listening', () => {
      console.info(`WebSocket server listening on port ${config.wsPort}`);
    });

    // Initialise SMTP transport
    this.smtpTransport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure ?? false,
      auth: {
        user: config.smtp.auth.user,
        pass: config.smtp.auth.pass,
      },
    });

    // Initialise rate‑limited queue
    this.queue = new PQueue({
      intervalCap: config.rateLimit.intervalCap,
      interval: config.rateLimit.interval,
      carryoverConcurrencyCount: true,
    });
  }

  /**
   * Validate configuration object.
   * Throws an Error if validation fails.
   */
  private validateConfig(config: NotifierConfig): void {
    if (!config) throw new Error('Config object is required.');
    if (typeof config.wsPort !== 'number' || config.wsPort <= 0) {
      throw new Error('Invalid wsPort in config.');
    }
    const smtp = config.smtp;
    if (!smtp || typeof smtp.host !== 'string' || !smtp.host) {
      throw new Error('Invalid SMTP host.');
    }
    if (typeof smtp.port !== 'number' || smtp.port <= 0) {
      throw new Error('Invalid SMTP port.');
    }
    if (!smtp.auth?.user || !smtp.auth?.pass) {
      throw new Error('SMTP auth credentials are required.');
    }
    if (!config.alertRecipient || typeof config.alertRecipient !== 'string') {
      throw new Error('Invalid alertRecipient.');
    }
    if (!config.rateLimit || typeof config.rateLimit.intervalCap !== 'number' ||
        typeof config.rateLimit.interval !== 'number') {
      throw new Error('Invalid rateLimit configuration.');
    }
    if (typeof config.aggregationWindowMs !== 'number' || config.aggregationWindowMs <= 0) {
      throw new Error('Invalid aggregationWindowMs.');
    }
  }

  /**
   * Starts consuming an asynchronous iterable of anomaly events.
   * @param eventStream Async iterable that yields AnomalyEvent objects.
   */
  public async start(eventStream: AsyncIterable<AnomalyEvent>): Promise<void> {
    try {
      for await (const event of eventStream) {
        this.handleEvent(event);
      }
    } catch (err) {
      console.error('Error while processing event stream:', err);
    }
  }

  /**
   * Handles a single anomaly event: aggregates it and schedules alert generation.
   */
  private handleEvent(event: AnomalyEvent): void {
    if (!this.isValidAnomalyEvent(event)) {
      console.warn('Received invalid anomaly event, ignoring:', event);
      return;
    }

    const key = event.correlationId;
    let entry = this.aggregationMap.get(key);
    if (!entry) {
      entry = {
        anomalies: [],
        timer: setTimeout(() => this.flushAggregation(key), this.config.aggregationWindowMs),
      };
      this.aggregationMap.set(key, entry);
    }
    entry.anomalies.push(event);
  }

  /**
   * Validates the structure of an AnomalyEvent.
   */
  private isValidAnomalyEvent(event: any): event is AnomalyEvent {
    return (
      event &&
      typeof event.id === 'string' &&
      typeof event.correlationId === 'string' &&
      typeof event.description === 'string' &&
      (typeof event.timestamp === 'string' || typeof event.timestamp === 'number')
    );
  }

  /**
   * Flushes aggregated anomalies for a given correlationId, creates an alert,
   * and enqueues it for dispatch.
   */
  private flushAggregation(correlationId: string): void {
    const entry = this.aggregationMap.get(correlationId);
    if (!entry) return;

    const anomalies = entry.anomalies;
    this.aggregationMap.delete(correlationId);
    clearTimeout(entry.timer);

    if (anomalies.length === 0) return;

    const alert: Alert = {
      correlationId,
      anomalyIds: anomalies.map(a => a.id),
      // Simple summary: concatenate descriptions (could be more sophisticated)
      summary: anomalies.map(a => a.description).join(' | '),
      generatedAt: new Date(),
    };

    this.queue.add(() => this.dispatchAlert(alert)).catch(err => {
      console.error('Failed to dispatch alert:', err);
    });
  }

  /**
   * Dispatches an alert via both WebSocket broadcast and SMTP email.
   */
  private async dispatchAlert(alert: Alert): Promise<void> {
    await Promise.all([
      this.broadcastWebSocket(alert),
      this.sendEmail(alert),
    ]);
  }

  /**
   * Broadcasts the alert to all connected WebSocket clients.
   */
  private async broadcastWebSocket(alert: Alert): Promise<void> {
    const payload = JSON.stringify