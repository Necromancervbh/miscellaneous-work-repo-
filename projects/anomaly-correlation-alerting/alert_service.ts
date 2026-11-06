import express, { Request, Response, NextFunction, Router } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { Server as WebSocketServer, WebSocket } from 'ws';
import Redis from 'ioredis';
import { DBSCAN } from 'ml-dbscan';
import { createServer } from 'http';
import { randomUUID } from 'crypto';
import { URL } from 'url';
import { promisify } from 'util';
import * as http from 'http';

/**
 * Configuration interface
 */
interface Config {
    jwtSecret: string;
    jwtIssuer?: string;
    redisUrl: string;
    httpPort: number;
    wsPort: number;
    tokenBucket: {
        capacity: number; // max tokens
        refillRate: number; // tokens per second
    };
    dbscan: {
        eps: number; // neighborhood radius
        minPoints: number; // minimum points to form a cluster
        windowSize: number; // number of recent events to keep for clustering
    };
}

/**
 * Orchestrator event payload
 */
interface OrchestratorEvent {
    userId: string;
    timestamp: number; // epoch ms
    features: number[]; // numeric feature vector
}

/**
 * JWT payload extension
 */
interface AuthPayload extends JwtPayload {
    sub: string; // user id
}

/**
 * Token bucket state stored in Redis
 * Stored as a hash: { tokens: number, lastRefill: number }
 */
interface TokenBucketState {
    tokens: number;
    lastRefill: number;
}

/**
 * Alert notification sent to WebSocket clients
 */
interface AlertNotification {
    eventId: string;
    userId: string;
    timestamp: number;
    anomalyScore: number;
    message: string;
}

/**
 * Main service class
 */
export class AlertService {
    private readonly config: Config;
    private readonly redis: Redis.Redis;
    private readonly app: express.Application;
    private readonly router: Router;
    private readonly httpServer: http.Server;
    private readonly wsServer: WebSocketServer;
    private readonly wsClients: Map<string, Set<WebSocket>> = new Map(); // userId -> connections

    constructor(config: Config) {
        this.config = config;
        this.redis = new Redis(this.config.redisUrl);
        this.app = express();
        this.router = express.Router();
        this.httpServer = createServer(this.app);
        this.wsServer = new WebSocketServer({ noServer: true });

        this.setupMiddleware();
        this.setupRoutes();
        this.setupWebSocket();
    }

    /**
     * Starts HTTP and WebSocket servers and subscribes to orchestrator events.
     */
    public async start(): Promise<void> {
        // Start HTTP server
        await new Promise<void>((resolve, reject) => {
            this.httpServer.listen(this.config.httpPort, (err?: Error) => {
                if (err) reject(err);
                else resolve();
            });
        });

        // Upgrade HTTP to WS
        this.httpServer.on('upgrade', (request, socket, head) => {
            const pathname = new URL(request.url ?? '', `http://${request.headers.host}`).pathname;
            if (pathname === '/ws') {
                this.wsServer.handleUpgrade(request, socket, head, (ws) => {
                    this.wsServer.emit('connection', ws, request);
                });
            } else {
                socket.destroy();
            }
        });

        // Subscribe to orchestrator events via Redis Pub/Sub
        const subscriber = new Redis(this.config.redisUrl);
        await subscriber.subscribe('orchestrator-events');
        subscriber.on('message', async (channel, message) => {
            if (channel === 'orchestrator-events') {
                try {
                    const event: OrchestratorEvent = JSON.parse(message);
                    await this.handleEvent(event);
                } catch (e) {
                    console.error('Failed to process orchestrator event:', e);
                }
            }
        });

        console.log(`AlertService started on HTTP port ${this.config.httpPort}`);
    }

    /**
     * Gracefully shuts down the service.
     */
    public async stop(): Promise<void> {
        await this.redis.quit();
        await this.httpServer.close();
        this.wsServer.close();
    }

    /**
     * Middleware setup: JSON parsing, JWT authentication.
     */
    private setupMiddleware(): void {
        this.app.use(express.json());

        // JWT authentication middleware
        this.app.use((req: Request, res: Response, next: NextFunction) => {
            const authHeader = req.headers.authorization;
            if (!authHeader?.startsWith('Bearer ')) {
                return res.status(401).json({ error: 'Missing Authorization header' });
            }
            const token = authHeader.slice(7);
            try {
                const payload = jwt.verify(token, this.config.jwtSecret, {
                    issuer: this.config.jwtIssuer,
                }) as AuthPayload;
                (req as any).user = { id: payload.sub };
                next();
            } catch (err) {
                return res.status(401).json({ error: 'Invalid token' });
            }
        });
    }

    /**
     * Define HTTP routes.
     */
    private setupRoutes(): void {
        // Health check
        this.router.get('/health', (req, res) => res.json({ status: 'ok' }));

        // Manual trigger for testing (secured)
        this.router.post('/trigger', async (req: Request, res: Response) => {
            const userId = (req as any).user.id;
            const { features } = req.body;
            if (!Array.isArray(features) || !features.every((v) => typeof v === 'number')) {
                return res.status(400).json({ error: 'Invalid features array' });
            }
            const event: OrchestratorEvent = {
                userId,
                timestamp: Date.now(),
                features,
            };
            await this.handleEvent(event);
            res.json({ status: 'event processed' });
        });

        this.app.use('/api', this.router);
    }

    /**
     * WebSocket connection handling.
     */
    private setupWebSocket(): void {
        this.wsServer.on('connection', (ws: WebSocket, request: http.IncomingMessage) => {
            const url = new URL(request.url ?? '', `http://${request.headers.host}`);
            const token = url.searchParams.get('token');
            if (!token) {
                ws.close(4001, 'Missing token');
                return;
            }
            let payload: AuthPayload;
            try {
                payload = jwt.verify(token, this.config.jwtSecret, {
                    issuer: this.config.jwtIssuer,
                }) as AuthPayload;
            } catch {
                ws.close(4002, 'Invalid token');
                return;
            }
            const userId = payload.sub;
            if (!this.wsClients.has(userId)) {
                this.wsClients.set(userId, new Set());
            }
            this.wsClients.get(userId)!.add(ws);

            ws.on('close', () => {
                this.wsClients.get(userId)!.delete(ws);
                if (this.wsClients.get(userId)!.size === 0) {
                    this.wsClients.delete(userId);
                }
            });
        });
    }

    /**
     * Core event handling pipeline.
     */
    private async handleEvent(event: OrchestratorEvent): Promise<void> {
        // Validate event
        if (!event.userId || typeof event.userId !== 'string') {
            throw new Error('Invalid userId');
        }
        if (!Array.isArray(event.features) || event.features.length === 0) {
            throw new Error('Invalid features');
        }

        // Store event in Redis list for sliding window clustering
        const windowKey = `events:${event.userId}`;
        const eventData = JSON.stringify(event);
        await this.redis.lpush(windowKey, eventData);
        await this.redis.ltrim(windowKey, 0