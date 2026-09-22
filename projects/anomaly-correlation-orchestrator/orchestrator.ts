import { EventEmitter } from 'events';
import WebSocket, { WebSocketServer } from 'ws';
import http from 'http';
import { setInterval, clearInterval } from 'timers';

/**
 * Types
 */
type AlertSource = 'kalman' | 'bayesian';

interface Alert {
  clientId: string;
  timestamp: number; // epoch ms
  metric: string;
  value: number;
  source: AlertSource;
}

interface AggregatedAnomaly {
  clientId: string;
  metric: string;
  latestValue: number;
  lastTimestamp: number;
  sources: Set<AlertSource>;
}

/**
 * Token bucket implementation for rate limiting.
 * Formula: tokens = min(capacity, tokens + refillRate * dt)
 * where dt is time elapsed in seconds.
 */
class TokenBucket {
  private capacity: number;
  private tokens: number;
  private refillRate: number; // tokens per second
  private lastRefill: number; // epoch ms

  constructor(capacity: number, refillRate: number) {
    if (capacity <= 0 || refillRate <= 0) {
      throw new Error('TokenBucket parameters must be positive numbers.');
    }
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = refillRate;
    this.lastRefill = Date.now();
  }

  /**
   * Attempt to consume a token.
   * @returns true if token was consumed, false otherwise.
   */
  public tryConsume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec <= 0) return;
    const added = elapsedSec * this.refillRate;
    this.tokens = Math.min(this.capacity, this.tokens + added);
    this.lastRefill = now;
  }
}

/**
 * RateLimiter maintains a token bucket per client.
 */
class RateLimiter {
  private buckets: Map<string, TokenBucket>;
  private capacity: number;
  private refillRate: number;

  constructor(capacity: number, refillRate: number) {
    this.buckets = new Map();
    this.capacity = capacity;
    this.refillRate = refillRate;
  }

  public canSend(clientId: string): boolean {
    let bucket = this.buckets.get(clientId);
    if (!bucket) {
      bucket = new TokenBucket(this.capacity, this.refillRate);
      this.buckets.set(clientId, bucket);
    }
    return bucket.tryConsume();
  }

  public removeClient(clientId: string): void {
    this.buckets.delete(clientId);
  }
}

/**
 * Aggregator merges alerts into per‑client, per‑metric anomalies.
 */
class Aggregator extends EventEmitter {
  private anomalies: Map<string, Map<string, AggregatedAnomaly>>; // clientId -> metric -> anomaly

  constructor() {
    super();
    this.anomalies = new Map();
  }

  public processAlert(alert: Alert): void {
    if (!alert.clientId || !alert.metric) {
      // Invalid alert, ignore but log
      console.warn('Received malformed alert:', alert);
      return;
    }

    let clientMap = this.anomalies.get(alert.clientId);
    if (!clientMap) {
      clientMap = new Map();
      this.anomalies.set(alert.clientId, clientMap);
    }

    let agg = clientMap.get(alert.metric);
    if (!agg) {
      agg = {
        clientId: alert.clientId,
        metric: alert.metric,
        latestValue: alert.value,
        lastTimestamp: alert.timestamp,
        sources: new Set([alert.source]),
      };
      clientMap.set(alert.metric, agg);
      this.emit('anomaly', agg);
      return;
    }

    // Update if newer timestamp
    if (alert.timestamp > agg.lastTimestamp) {
      agg.latestValue = alert.value;
      agg.lastTimestamp = alert.timestamp;
    }
    agg.sources.add(alert.source);
    this.emit('anomaly', agg);
  }

  public getAnomaly(clientId: string, metric: string): AggregatedAnomaly | undefined {
    return this.anomalies.get(clientId)?.get(metric);
  }
}

/**
 * WebSocket multiplexing server.
 * Clients send a JSON message: { type: 'subscribe', clientId: string }
 * Server sends: { type: 'anomaly', data: AggregatedAnomaly }
 */
class MultiplexedWSServer {
  private wss: WebSocketServer;
  private clientSubscriptions: Map<string, Set<WebSocket>>; // clientId -> connections
  private rateLimiter: RateLimiter;

  constructor(server: http.Server, rateLimiter: RateLimiter) {
    this.wss = new WebSocketServer({ server });
    this.clientSubscriptions = new Map();
    this.rateLimiter = rateLimiter;

    this.wss.on('connection', (ws: WebSocket) => this.handleConnection(ws));
    this.wss.on('error', (err) => {
      console.error('WebSocket server error:', err);
    });
  }

  private handleConnection(ws: WebSocket): void {
    const subscribedClients = new Set<string>();

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'subscribe' && typeof msg.clientId === 'string') {
          const clientId = msg.clientId.trim();
          if (!clientId) {
            ws.send(JSON.stringify({ type: 'error', message: 'clientId cannot be empty' }));
            return;
          }
          let set = this.clientSubscriptions.get(clientId);
          if (!set) {
            set = new Set();
            this.clientSubscriptions.set(clientId, set);
          }
          set.add(ws);
          subscribedClients.add(clientId);
        } else {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
        }
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', message: 'Failed to parse message' }));
      }
    });

    ws.on('close', () => {
      for (const clientId of subscribedClients) {
        const set = this.clientSubscriptions.get(clientId);
        if (set) {
          set.delete(ws);
          if (set.size === 0) {
            this.clientSubscriptions