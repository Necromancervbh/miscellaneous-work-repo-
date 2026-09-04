import http from 'http';
import { IncomingMessage } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import jwt, { JwtPayload } from 'jsonwebtoken';
import Redis from 'ioredis';
import LRUCache from 'lru-cache';

/**
 * Interface for hub configuration options.
 */
interface DashboardHubOptions {
  /** Port on which the WebSocket server will listen. */
  port: number;
  /** Secret key used to verify JWT tokens. */
  jwtSecret: string;
  /** Redis connection URL (e.g., redis://localhost:6379). */
  redisUrl?: string;
  /** Maximum number of messages a user can send per second (rate limit). */
  rateLimit?: number;
  /** Burst capacity for the token bucket algorithm. */
  rateLimitBurst?: number;
  /** Maximum number of cached anomaly events per metric. */
  cacheSize?: number;
}

/**
 * Token bucket state for a single user.
 * tokens: current token count.
 * lastRefill: timestamp (ms) of the last refill.
 */
interface RateLimitState {
  tokens: number;
  lastRefill: number;
}

/**
 * DashboardHub implements a multiplexed WebSocket hub with JWT authentication,
 * per‑user rate limiting, subscription management, and broadcasting of anomaly events.
 */
export class DashboardHub {
  private readonly wss: WebSocketServer;
  private readonly server: http.Server;
  private readonly redis: Redis;
  private readonly redisSubscriber: Redis;
  private readonly jwtSecret: string;
  private readonly rateLimit: number;
  private readonly rateLimitBurst: number;
  private readonly userRateLimits: Map<string, RateLimitState> = new Map();
  private readonly subscriptions: Map<string, Set<WebSocket>> = new Map(); // metric -> sockets
  private readonly socketMetrics: Map<WebSocket, Set<string>> = new Map(); // socket -> metrics
  private readonly cache: LRUCache<string, any>;

  /**
   * Constructs a new DashboardHub.
   * @param options Configuration options.
   */
  constructor(options: DashboardHubOptions) {
    const {
      port,
      jwtSecret,
      redisUrl = 'redis://127.0.0.1:6379',
      rateLimit = 5,
      rateLimitBurst = 10,
      cacheSize = 1000,
    } = options;

    this.jwtSecret = jwtSecret;
    this.rateLimit = rateLimit;
    this.rateLimitBurst = rateLimitBurst;

    // Initialize LRU cache: key = `${metric}:${eventId}`, value = event payload
    this.cache = new LRUCache<string, any>({ max: cacheSize });

    // Create HTTP server (required for proper shutdown handling)
    this.server = http.createServer();

    // Initialize WebSocket server
    this.wss = new WebSocketServer({ server: this.server });

    // Initialize Redis clients
    this.redis = new Redis(redisUrl);
    this.redisSubscriber = new Redis(redisUrl);

    // Bind event handlers
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => this.handleConnection(ws, req));

    // Subscribe to Redis channel for anomaly events
    this.redisSubscriber.subscribe('anomaly_events', (err, count) => {
      if (err) {
        console.error('Failed to subscribe to anomaly_events channel:', err);
      } else {
        console.info(`Subscribed to ${count} Redis channel(s) for anomaly events.`);
      }
    });

    this.redisSubscriber.on('message', (channel: string, message: string) => {
      if (channel === 'anomaly_events') {
        try {
          const event = JSON.parse(message);
          this.processAnomalyEvent(event);
        } catch (e) {
          console.error('Failed to parse anomaly event from Redis:', e);
        }
      }
    });

    // Start listening
    this.server.listen(port, () => {
      console.info(`DashboardHub WebSocket server listening on port ${port}`);
    });
  }

  /**
   * Handles a new WebSocket connection.
   * Performs JWT authentication and sets up message handling.
   */
  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    try {
      const token = this.extractTokenFromRequest(req);
      if (!token) {
        ws.close(4001, 'Authentication token missing');
        return;
      }

      const payload = this.authenticate(token);
      if (!payload) {
        ws.close(4002, 'Invalid authentication token');
        return;
      }

      const userId = String(payload.userId);
      // Initialize rate limit state for the user if not present
      if (!this.userRateLimits.has(userId)) {
        this.userRateLimits.set(userId, { tokens: this.rateLimitBurst, lastRefill: Date.now() });
      }

      // Store subscribed metrics set for cleanup later
      this.socketMetrics.set(ws, new Set());

      ws.on('message', (data) => this.handleMessage(ws, userId, data));
      ws.on('close', () => this.cleanupSocket(ws));
      ws.on('error', (err) => {
        console.error(`WebSocket error for user ${userId}:`, err);
        ws.close(101