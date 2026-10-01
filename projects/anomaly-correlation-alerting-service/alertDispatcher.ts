import { Server as WebSocketServer, WebSocket } from 'ws';
import jwt, { JwtPayload } from 'jsonwebtoken';
import LRUCache from 'lru-cache';
import { EventEmitter } from 'events';
import { setTimeout as delay } from 'timers/promises';

/**
 * Types
 */
export interface PredictorEvent {
    timestamp: number; // Unix epoch ms
    anomalies: Anomaly[];
    [key: string]: any;
}

export interface Anomaly {
    id: string;
    x: number; // feature dimension 1
    y: number; // feature dimension 2
    severity: number;
    [key: string]: any;
}

export interface Alert {
    clusterId: number;
    anomalies: Anomaly[];
    generatedAt: number;
}

/**
 * DBSCAN clustering implementation
 */
class DBSCAN {
    private eps: number;
    private minPts: number;

    constructor(eps: number, minPts: number) {
        if (eps <= 0) throw new Error('eps must be > 0');
        if (minPts <= 0) throw new Error('minPts must be > 0');
        this.eps = eps;
        this.minPts = minPts;
    }

    /**
     * Euclidean distance between two points.
     * d(p,q) = sqrt((p.x - q.x)^2 + (p.y - q.y)^2)
     */
    private distance(p: Anomaly, q: Anomaly): number {
        const dx = p.x - q.x;
        const dy = p.y - q.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    /**
     * Returns indices of points within eps of point i.
     */
    private regionQuery(points: Anomaly[], i: number): number[] {
        const neighbors: number[] = [];
        for (let j = 0; j < points.length; j++) {
            if (this.distance(points[i], points[j]) <= this.eps) {
                neighbors.push(j);
            }
        }
        return neighbors;
    }

    /**
     * Performs DBSCAN clustering.
     * Returns an array where each element is the cluster id (>=0) or -1 for noise.
     */
    public run(points: Anomaly[]): number[] {
        const labels = new Array(points.length).fill(-1); // -1 = unvisited/noise
        let clusterId = 0;

        for (let i = 0; i < points.length; i++) {
            if (labels[i] !== -1) continue; // already processed

            const neighbors = this.regionQuery(points, i);
            if (neighbors.length < this.minPts) {
                labels[i] = -1; // noise
                continue;
            }

            // Expand cluster
            this.expandCluster(points, labels, i, neighbors, clusterId);
            clusterId++;
        }

        return labels;
    }

    private expandCluster(
        points: Anomaly[],
        labels: number[],
        pointIdx: number,
        neighbors: number[],
        clusterId: number
    ): void {
        labels[pointIdx] = clusterId;
        const queue = [...neighbors];

        while (queue.length > 0) {
            const currentIdx = queue.shift()!;
            if (labels[currentIdx] === -1) {
                // Previously labeled as noise, now part of cluster
                labels[currentIdx] = clusterId;
            }
            if (labels[currentIdx] !== -1) continue; // already assigned to a cluster

            labels[currentIdx] = clusterId;
            const currentNeighbors = this.regionQuery(points, currentIdx);
            if (currentNeighbors.length >= this.minPts) {
                queue.push(...currentNeighbors);
            }
        }
    }
}

/**
 * Rate limiter per client using token bucket algorithm.
 */
class TokenBucket {
    private capacity: number;
    private tokens: number;
    private refillRate: number; // tokens per ms
    private lastRefill: number;

    constructor(capacity: number, refillPerSecond: number) {
        if (capacity <= 0) throw new Error('Bucket capacity must be > 0');
        if (refillPerSecond <= 0) throw new Error('Refill rate must be > 0');
        this.capacity = capacity;
        this.tokens = capacity;
        this.refillRate = refillPerSecond / 1000;
        this.lastRefill = Date.now();
    }

    private refill(): void {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        const added = elapsed * this.refillRate;
        this.tokens = Math.min(this.capacity, this.tokens + added);
        this.lastRefill = now;
    }

    public tryRemove(tokens: number = 1): boolean {
        this.refill();
        if (this.tokens >= tokens) {
            this.tokens -= tokens;
            return true;
        }
        return false;
    }
}

/**
 * Main dispatcher class.
 */
export class AlertDispatcher {
    private wss: WebSocketServer;
    private jwtSecret: string;
    private dbscan: DBSCAN;
    private alertCache: LRUCache<string, Alert>;
    private clientBuckets: Map<string, TokenBucket>;
    private maxTokensPerSecond: number;
    private bucketCapacity: number;
    private eventEmitter: EventEmitter;

    /**
     * @param wss WebSocket server instance.
     * @param jwtSecret Secret used to verify JWT tokens.
     * @param eps DBSCAN epsilon distance.
     * @param minPts DBSCAN minimum points.
     * @param cacheSize Maximum number of alerts to keep in LRU cache.
     * @param bucketCapacity Maximum burst size for rate limiting.
     * @param maxTokensPerSecond Refill rate for token bucket.
     */
    constructor(
        wss: WebSocketServer,
        jwtSecret: string,
        eps: number = 0.5,
        minPts: number = 3,
        cacheSize: number = 500,
        bucketCapacity: number = 10,
        maxTokensPerSecond: number = 5
    ) {
        if (!wss) throw new Error('WebSocketServer instance required');
        if (!jwtSecret) throw new Error('JWT secret required');

        this.wss = wss;
        this.jwtSecret = jwtSecret;
        this.dbscan = new DBSCAN(eps, minPts);
        this.alertCache = new LRUCache<string, Alert>({ max: cacheSize });
        this.clientBuckets = new Map();
        this.bucketCapacity = bucketCapacity;
        this.maxTokensPerSecond = maxTokensPerSecond;
        this.eventEmitter = new EventEmitter();

        this.setupWebSocketHandlers();
    }

    /**
     * Handles incoming predictor events.
     */
    public async handleEvent(event: PredictorEvent): Promise<void> {
        if (!event || typeof event.timestamp !== 'number' || !Array.isArray(event.anomalies)) {
            throw new Error('Invalid PredictorEvent structure');
        }

        const anomalies = event.anomalies;
        if (anomalies.length === 0) return; // nothing to process

        const clusterLabels = this.dbscan.run(anomalies);
        const clusters = new Map<number, Anomaly[]>();

        clusterLabels.forEach((label, idx) => {
            if (label === -1) return; // ignore noise
            if (!clusters.has(label)) clusters.set(label, []);
            clusters.get(label)!.push(anomalies[idx]);
        });

        for (const [clusterId, clusterAnomalies] of clusters.entries()) {
            const alertKey = this.generateAlertKey(clusterId, clusterAnomalies);
            if (this.alertCache.has(alertKey)) continue; // duplicate recent alert

            const alert: Alert = {
                clusterId,
                anomalies: clusterAnomalies,
                generatedAt: Date.now(),
            };
            this.alertCache.set(alertKey, alert);
            this.enqueueAlert(alert);
        }
    }

    /**
     * Generates a deterministic key for an alert to be stored in LRU cache.
     * Uses sorted anomaly IDs to ensure identical clusters map