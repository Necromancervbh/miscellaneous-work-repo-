import http from 'http';
import url from 'url';
import { Server as WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import LRUCache from 'lru-cache';
import DBSCAN from 'ml-dbscan';
import { EventEmitter } from 'events';
import { AddressInfo } from 'net';

/**
 * Types
 */
interface AnomalyEvent {
    id: string;
    timestamp: number; // epoch ms
    features: number[]; // numeric feature vector
}

interface Cluster {
    id: string;
    members: string[]; // array of anomaly ids
    centroid: number[]; // average of member feature vectors
    createdAt: number;
}

/**
 * Configuration
 */
interface InsightEngineConfig {
    httpPort?: number;               // Port for HTTP server (WebSocket upgrade)
    jwtSecret: string;               // Secret for JWT verification
    dbscanEps?: number;              // DBSCAN epsilon
    dbscanMinPts?: number;           // DBSCAN minimum points
    clusterCacheSize?: number;       // Max number of clusters cached
    rateLimitPerSec?: number;        // Max messages per client per second
    clusteringIntervalMs?: number;   // How often to recompute clusters
    eventBufferSize?: number;        // Max events to keep for clustering
}

/**
 * Simple token bucket rate limiter per client
 */
class RateLimiter {
    private maxTokens: number;
    private refillInterval: number;
    private tokensMap: Map<string, { tokens: number; lastRefill: number }>;

    constructor(maxPerSec: number) {
        this.maxTokens = maxPerSec;
        this.refillInterval = 1000; // ms
        this.tokensMap = new Map();
    }

    public tryRemoveToken(clientId: string): boolean {
        const now = Date.now();
        const entry = this.tokensMap.get(clientId) ?? { tokens: this.maxTokens, lastRefill: now };
        const elapsed = now - entry.lastRefill;

        // Refill tokens based on elapsed time
        const refillTokens = Math.floor((elapsed / this.refillInterval) * this.maxTokens);
        if (refillTokens > 0) {
            entry.tokens = Math.min(this.maxTokens, entry.tokens + refillTokens);
            entry.lastRefill = now;
        }

        if (entry.tokens > 0) {
            entry.tokens -= 1;
            this.tokensMap.set(clientId, entry);
            return true;
        }

        this.tokensMap.set(clientId, entry);
        return false;
    }
}

/**
 * InsightEngine class
 */
export class InsightEngine extends EventEmitter {
    private config: Required<InsightEngineConfig>;
    private httpServer: http.Server;
    private wss: WebSocketServer;
    private clients: Set<WebSocket>;
    private eventBuffer: AnomalyEvent[];
    private clusterCache: LRUCache<string, Cluster>;
    private rateLimiter: RateLimiter;
    private clusteringTimer: NodeJS.Timeout | null;

    constructor(config: InsightEngineConfig) {
        super();

        // Validate required config
        if (!config.jwtSecret) {
            throw new Error('jwtSecret is required in config');
        }

        // Apply defaults
        this.config = {
            httpPort: config.httpPort ?? 8080,
            jwtSecret: config.jwtSecret,
            dbscanEps: config.dbscanEps ?? 0.5,
            dbscanMinPts: config.dbscanMinPts ?? 5,
            clusterCacheSize: config.clusterCacheSize ?? 100,
            rateLimitPerSec: config.rateLimitPerSec ?? 10,
            clusteringIntervalMs: config.clusteringIntervalMs ?? 5000,
            eventBufferSize: config.eventBufferSize ?? 1000,
        };

        this.httpServer = http.createServer(this.handleHttpRequest.bind(this));
        this.wss = new WebSocketServer({ noServer: true });
        this.clients = new Set();
        this.eventBuffer = [];
        this.clusterCache = new LRUCache<string, Cluster>({ max: this.config.clusterCacheSize });
        this.rateLimiter = new RateLimiter(this.config.rateLimitPerSec);
        this.clusteringTimer = null;

        this.setupWebSocketHandling();
    }

    /**
     * Starts the HTTP server and clustering loop.
     */
    public start(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.httpServer.listen(this.config.httpPort, () => {
                const address = this.httpServer.address() as AddressInfo;
                console.log(`InsightEngine HTTP server listening on port ${address.port}`);
                this.startClusteringLoop();
                resolve();
            });
            this.httpServer.on('error', (err) => reject(err));
        });
    }

    /**
     * Gracefully stops the service.
     */
    public async stop(): Promise<void> {
        if (this.clusteringTimer) {
            clearInterval(this.clusteringTimer);
            this.clusteringTimer = null;
        }
        for (const client of this.clients) {
            client.terminate();
        }
        this.wss.close();
        await new Promise<void>((resolve, reject) => {
            this.httpServer.close((err) => (err ? reject(err) : resolve()));
        });
    }

    /**
     * Public method to ingest an anomaly event.
     */
    public ingestEvent(event: unknown): void {
        try {
            const validated = this.validateEvent(event);
            this.eventBuffer.push(validated);
            // Trim buffer if exceeds size
            if (this.eventBuffer.length > this.config.eventBufferSize) {
                this.eventBuffer.shift();
            }
        } catch (err) {
            console.error('Failed to ingest event:', err);
        }
    }

    /**
     * Validates the incoming event shape.
     */
    private validateEvent(event: unknown): AnomalyEvent {
        if (typeof event !== 'object' || event === null) {
            throw new Error('Event must be an object');
        }
        const e = event as any;
        if (typeof e.id !== 'string' || e.id.trim() === '') {
            throw new Error('Event id must be a non-empty string');
        }
        if (typeof e.timestamp !== 'number' || !Number.isFinite(e.timestamp)) {
            throw new Error('Event timestamp must be a finite number');
        }
        if (!Array.isArray(e.features) || e.features.length === 0) {
            throw new Error('Event features must be a non-empty array');
        }
        for (const v of e.features) {
            if (typeof v !== 'number' || !Number.isFinite(v)) {
                throw new Error('All feature values must be finite numbers');
            }
        }
        return {
            id: e.id,
            timestamp: e.timestamp,
            features: e.features,
        };
    }

    /**
     * Handles plain HTTP requests (used only for health checks).
     */
    private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        const parsedUrl = url.parse(req.url