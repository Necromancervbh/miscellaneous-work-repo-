import http from 'http';
import url from 'url';
import { Server as WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import Redis from 'ioredis';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

/**
 * Configuration loaded from environment variables.
 */
const CONFIG = {
    WS_PORT: parseInt(process.env.WS_PORT || '8080', 10),
    JWT_SECRET: process.env.JWT_SECRET || 'your-secret-key',
    REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    REDIS_CHANNEL: process.env.REDIS_CHANNEL || 'alerting:events',
    RATE_LIMIT_CAPACITY: parseInt(process.env.RATE_LIMIT_CAPACITY || '10', 10), // max tokens
    RATE_LIMIT_REFILL_RATE: parseFloat(process.env.RATE_LIMIT_REFILL_RATE || '5'), // tokens per second
    AGGREGATION_TTL_MS: parseInt(process.env.AGGREGATION_TTL_MS || '300000', 10), // 5 minutes
};

/**
 * Interface representing a raw anomaly event received from the alerting service.
 */
interface AnomalyEvent {
    id: string;
    correlationId: string;
    metric: string;
    value: number;
    timestamp: number; // epoch ms
}

/**
 * Interface representing an aggregated anomaly for a given correlationId.
 */
interface AggregatedAnomaly {
    correlationId: string;
    count: number;
    metrics: Set<string>;
    firstSeen: number;
    lastSeen: number;
}

/**
 * Token bucket state for rate limiting.
 * Formula:
 *   tokens = min(capacity, tokens + (now - lastRefill) * refillRate)
 */
interface TokenBucket {
    tokens: number;
    lastRefill: number; // epoch ms
}

/**
 * Main server class handling WebSocket connections, JWT authentication,
 * rate limiting, Redis subscription, aggregation, and broadcasting.
 */
export class RealTimeDashboardServer extends EventEmitter {
    private httpServer: http.Server;
    private wss: WebSocketServer;
    private redisSubscriber: Redis.Redis;
    private clientBuckets: Map<string, TokenBucket> = new Map(); // key: clientId (sub claim)
    private aggregated: Map<string, AggregatedAnomaly> = new Map(); // key: correlationId
    private cleanupInterval: NodeJS.Timeout;

    constructor() {
        super();

        this.httpServer = http.createServer();
        this.wss = new WebSocketServer({ noServer: true });
        this.redisSubscriber = new Redis(CONFIG.REDIS_URL);

        this.setupHttpUpgrade();
        this.setupWebSocketHandlers();
        this.setupRedisSubscription();
        this.startAggregationCleanup();

        this.httpServer.listen(CONFIG.WS_PORT, () => {
            console.info(`WebSocket server listening on port ${CONFIG.WS_PORT}`);
        });
    }

    /**
     * Handles HTTP Upgrade requests to upgrade them to WebSocket connections.
     */
    private setupHttpUpgrade() {
        this.httpServer.on('upgrade', (request, socket, head) => {
            const parsedUrl = url.parse(request.url || '', true);
            const token = parsedUrl.query.token as string | undefined;

            if (!token) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }

            let payload: any;
            try {
                payload = jwt.verify(token, CONFIG.JWT_SECRET);
            } catch (err) {
                socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
                socket.destroy();
                return;
            }

            // Attach authenticated user info to request for later use
            (request as any).auth = { sub: payload.sub ?? uuidv4() };

            this.wss.handleUpgrade(request, socket, head, (ws) => {
                this.wss.emit('connection', ws, request);
            });
        });
    }

    /**
     * Sets up WebSocket connection, message handling, and cleanup.
     */
    private setupWebSocketHandlers() {
        this.wss.on('connection', (ws: WebSocket, request: http.IncomingMessage) => {
            const auth = (request as any).auth;
            const clientId: string = auth.sub;

            // Initialize token bucket for this client
            this.clientBuckets.set(clientId, {
                tokens: CONFIG.RATE_LIMIT_CAPACITY,
                lastRefill: Date.now(),
            });

            ws.on('close', () => {
                this.clientBuckets.delete(clientId);
            });

            ws.on('error', (err) => {
                console.error(`WebSocket error for client ${clientId}:`, err);
                ws.close();
            });

            // Optional: handle inbound messages if needed (e.g., ping)
            ws.on('message', (data) => {
                // Simple echo for keep-alive; can be expanded.
                if (typeof data === 'string' && data === 'ping') {
                    ws.send('pong');
                }
            });
        });
    }

    /**
     * Subscribes to Redis channel to receive anomaly events.
     */
    private async setupRedisSubscription() {
        this.redisSubscriber.on('error', (err) => {
            console.error('Redis subscriber error:', err);
        });

        await this.redisSubscriber.subscribe(CONFIG.REDIS_CHANNEL);
        this.redisSubscriber.on('message', (channel, message) => {
            if (channel !== CONFIG.REDIS_CHANNEL) return;
            this.handleIncomingEvent(message);
        });
    }

    /**
     * Parses and processes a raw event message from Redis.
     */
    private handleIncomingEvent(message: string) {
        let event: AnomalyEvent;
        try {
            const parsed = JSON.parse(message);
            // Basic validation
            if (
                typeof parsed.id !== 'string' ||
                typeof parsed.correlationId !== 'string' ||
                typeof parsed.metric !== 'string' ||
                typeof parsed.value !== 'number' ||
                typeof parsed.timestamp !== 'number'
            ) {
                throw new Error('Invalid event structure');
            }
            event = parsed as AnomalyEvent;
        } catch (err) {
            console.warn('Failed to parse anomaly event:', err);
            return;
        }

        this.aggregateEvent(event);
        this.broadcastAggregated(event.correlationId);
    }

    /**
     * Updates aggregation state for a given anomaly event.
     */
    private aggregateEvent(event: AnomalyEvent) {
        const now = Date.now();
        let agg = this.aggregated.get(event.correlationId);
        if (!agg) {
            agg = {
                correlationId: event.correlationId,
                count: 0,
                metrics: new Set<string>(),
                firstSeen: now,
                lastSeen: now,
            };
            this.aggregated.set(event.correlationId, agg);
        }