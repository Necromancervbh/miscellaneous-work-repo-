import { createServer, Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import nodemailer, { Transporter } from 'nodemailer';
import Redis from 'ioredis';
import LRUCache from 'lru-cache';
import { DBSCAN } from 'ml-dbscan';
import { EventEmitter } from 'events';
import { URL } from 'url';
import { inspect } from 'util';

// ---------------------------
// Types and Interfaces
// ---------------------------

export interface AnomalyEvent {
  id: string; // unique identifier
  timestamp: number; // epoch ms
  metrics: Record<string, number>; // numeric features for clustering
  source: string; // origin of the event
}

export interface Alert {
  id: string; // unique alert id
  clusterId: string; // identifier of the cluster that triggered the alert
  severity: number; // computed severity score
  events: AnomalyEvent[]; // events belonging to the cluster
  generatedAt: number; // epoch ms
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  auth: {
    user: string;
    pass: string;
  };
  from: string; // sender email address
  to: string[]; // recipient list
}

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db?: number;
}

export interface AlertEngineConfig {
  dbscanEpsilon: number; // radius for DBSCAN (ε)
  dbscanMinPoints: number; // minimum points for a cluster (minPts)
  cacheSize: number; // max number of alerts to keep in LRU cache
  batchSize: number; // number of events to accumulate before processing
  batchIntervalMs: number; // max wait time before processing batch
  smtp: SmtpConfig;
  wsPort: number; // port for WebSocket server
  redis: RedisConfig;
}

// ---------------------------
// Helper Functions
// ---------------------------

/**
 * Validates that an object conforms to the AnomalyEvent interface.
 * Throws TypeError if validation fails.
 */
function validateAnomalyEvent(event: any): asserts event is AnomalyEvent {
  if (typeof event !== 'object' || event === null) {
    throw new TypeError('AnomalyEvent must be an object');
  }
  if (typeof event.id !== 'string' || event.id.trim() === '') {
    throw new TypeError('AnomalyEvent.id must be a non‑empty string');
  }
  if (typeof event.timestamp !== 'number' || !Number.isFinite(event.timestamp)) {
    throw new TypeError('AnomalyEvent.timestamp must be a finite number');
  }
  if (typeof event.source !== 'string' || event.source.trim() === '') {
    throw new TypeError('AnomalyEvent.source must be a non‑empty string');
  }
  if (typeof event.metrics !== 'object' || event.metrics === null) {
    throw new TypeError('AnomalyEvent.metrics must be an object');
  }
  for (const [k, v] of Object.entries(event.metrics)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new TypeError(`AnomalyEvent.metrics[${k}] must be a finite number`);
    }
  }
}

/**
 * Transforms an AnomalyEvent into a numeric vector suitable for DBSCAN.
 * The vector order follows the alphabetical order of metric keys to guarantee
 * deterministic clustering.
 */
function eventToVector(event: AnomalyEvent): number[] {
  const keys = Object.keys(event.metrics).sort();
  return keys.map((k) => event.metrics[k]);
}

/**
 * Generates a deterministic UUID‑v4 like identifier for an alert.
 * Uses crypto random values for uniqueness.
 */
function generateAlertId(): string {
  // eslint-disable-next-line node/no-unsupported-features/node-builtins
  return crypto.randomUUID();
}

/**
 * Computes a severity score for a cluster.
 * Formula: severity = (Σ_i Σ_j |metric_j|) / (N * M)
 * where N = number of events, M = number of metrics per event.
 * The score is normalized to the range [0, 1] assuming metric absolute values ≤ 1.
 */
function computeSeverity(events: AnomalyEvent[]): number {
  if (events.length === 0) return 0;
  const metricCount = Object.keys(events[0].metrics).length;
  let sumAbs = 0;
  for (const ev of events) {
    for (const val of Object.values(ev.metrics)) {
      sumAbs += Math.abs(val);
    }
  }
  const rawScore = sumAbs / (events.length * metricCount);
  // Clamp to [0,1] in case of out‑of‑range values
  return Math.min(1, Math.max(0, rawScore));
}

// ---------------------------
// AlertEngine Implementation
// ---------------------------

export class AlertEngine extends EventEmitter {
  private readonly config: AlertEngineConfig;
  private readonly cache: LRUCache<string, Alert>;
  private readonly redis: Redis.Redis;
  private readonly smtpTransporter: Transporter;
  private readonly wss: WebSocketServer;
  private readonly httpServer: HttpServer;
  private readonly eventBuffer: AnomalyEvent[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private readonly dbscan: DBSCAN<number[]>;

  constructor(config: AlertEngineConfig) {
    super();

    // Validate config (basic)
    if (config.dbscanEpsilon <= 0) {
      throw new RangeError('dbscanEpsilon must be > 0');
    }
    if (config.dbscanMinPoints < 1) {
      throw new RangeError('dbscanMinPoints must be >= 1');
    }
    if (config.cacheSize < 1) {
      throw new RangeError('cacheSize must be >= 1');
    }
    if (config.batchSize < 1) {
      throw new RangeError('batchSize must be >= 1');
    }
    if (config.batchIntervalMs < 10) {
      throw new RangeError('batchIntervalMs must be >= 10');
    }

    this.config = config;

    // LRU cache for recent alerts
    this.cache = new LRUCache<string, Alert>({
      max: config.cacheSize,
    });

    // Redis client for optional persistence / pub‑sub
    this.redis = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      db: config.redis.db,
    });