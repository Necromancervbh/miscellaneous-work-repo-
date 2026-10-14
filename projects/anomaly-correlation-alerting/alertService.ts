import express, { Request, Response, NextFunction } from 'express';
import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { Queue, Worker, Job } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';
import DBSCAN from 'ml-dbscan';
import { EventEmitter } from 'events';
import { URLSearchParams } from 'url';
import * as os from 'os';
import * as process from 'process';

/**
 * Types
 */
interface AnomalyScore {
    userId: string;
    timestamp: number; // epoch ms
    score: number;
    dimensions?: number[]; // optional multi‑dimensional features for clustering
}

interface Alert {
    id: string;
    userId: string;
    timestamp: number;
    clusterId: number;
    scores: AnomalyScore[];
}

/**
 * Kalman filter for 1‑D data.
 * Equations:
 *   Predict:   x̂ₖ|ₖ₋₁ = x̂ₖ₋₁|ₖ₋₁
 *               Pₖ|ₖ₋₁ = Pₖ₋₁|ₖ₋₁ + Q
 *   Update:    Kₖ = Pₖ|ₖ₋₁ / (Pₖ|ₖ₋₁ + R)
 *               x̂ₖ|ₖ = x̂ₖ|ₖ₋₁ + Kₖ (zₖ - x̂ₖ|ₖ₋₁)
 *               Pₖ|ₖ = (1 - Kₖ) Pₖ|ₖ₋₁
 */
class KalmanFilter1D {
    private estimate: number;
    private errorCovariance: number;
    private readonly processNoise: number;
    private readonly measurementNoise: number;

    constructor(initialEstimate = 0, initialErrorCovariance = 1, processNoise = 1e-5, measurementNoise = 1e-2) {
        this.estimate = initialEstimate;
        this.errorCovariance = initialErrorCovariance;
        this.processNoise = processNoise;
        this.measurementNoise = measurementNoise;
    }

    public filter(measurement: number): number {
        // Predict
        const predictedEstimate = this.estimate;
        const predictedErrorCov = this.errorCovariance + this.processNoise;

        // Update
        const kalmanGain = predictedErrorCov / (predictedErrorCov + this.measurementNoise);
        this.estimate = predictedEstimate + kalmanGain * (measurement - predictedEstimate);
        this.errorCovariance = (1 - kalmanGain) * predictedErrorCov;

        return this.estimate;
    }
}

/**
 * Simple token‑bucket rate limiter per user.
 */
class RateLimiter {
    private readonly capacity: number;
    private readonly refillIntervalMs: number;
    private readonly tokensPerRefill: number;
    private readonly userBuckets: Map<string, { tokens: number; lastRefill: number }> = new Map();

    constructor(requestsPerMinute: number) {
        this.capacity = requestsPerMinute;
        this.refillIntervalMs = 60_000;
        this.tokensPerRefill = requestsPerMinute;
    }

    public isAllowed(userId: string): boolean {
        const now = Date.now();
        const bucket = this.userBuckets.get(userId) ?? { tokens: this.capacity, lastRefill: now };
        const elapsed = now - bucket.lastRefill;

        if (elapsed >= this.refillIntervalMs) {
            const refillCount = Math.floor(elapsed / this.refillIntervalMs);
            bucket.tokens = Math.min(this.capacity, bucket.tokens + refillCount * this.tokensPerRefill);
            bucket.lastRefill += refillCount * this.refillIntervalMs;
        }

        if (bucket.tokens > 0) {
            bucket.tokens -= 1;
            this.userBuckets.set(userId, bucket);
            return true;
        }

        this.userBuckets.set(userId, bucket);
        return false;
    }
}

/**
 * WebSocket manager handling multiplexed channels per user.
 */
class WebSocketManager {
    private readonly wss: WebSocketServer;
    private readonly connections: Map<string, Set<WebSocket>> = new Map();

    constructor(server: HttpServer) {
        this.wss = new WebSocketServer({ server, path: '/ws' });
        this.wss.on('connection', (ws: WebSocket, req) => this.handleConnection(ws, req));
    }

    private async handleConnection(ws: WebSocket, req: Request): Promise<void> {
        try {
            const url = new URL(`http://${req.headers.host}${req.url}`);
            const token = url.searchParams.get('token');
            if (!token) {
                ws.close(4001, 'Missing token');
                return;
            }

            const payload = jwt.verify(token, process.env.JWT_SECRET ?? 'default_secret') as JwtPayload;
            const userId = payload.sub as string;
            if (!userId) {
                ws.close(4002, 'Invalid token payload');
                return;
            }

            if (!this.connections.has(userId)) {
                this.connections.set(userId, new Set());
            }
            this.connections.get(userId)!.add(ws);

            ws.on('close', () => {
                this.connections.get(userId)!.delete(ws);
                if (this.connections.get(userId)!.size === 0) {
                    this.connections.delete(userId);
                }
            });
        } catch (err) {
            ws.close(4003, 'Authentication failed');
        }
    }

    public sendAlert(alert: Alert): void {
        const userConns = this.connections.get(alert.userId);
        if (!userConns) return;
        const message = JSON.stringify({ type: 'alert', payload: alert });
        for (const ws of userConns) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(message);
            }
        }
    }
}

/**
 * Main service class.
 */
export class AlertService {
    private readonly app = express();
    private readonly httpServer: HttpServer;
    private readonly wsManager: WebSocketManager;
    private readonly alertQueue: Queue<Alert>;
    private readonly alertWorker: Worker<Alert>;
    private readonly rateLimiter: RateLimiter;
    private readonly userFilters: Map<string, KalmanFilter1D> = new Map();
    private readonly userScoreBuffers: Map<string, AnomalyScore[]> = new Map();
    private readonly dbscanEpsilon: number = 0.5;
    private readonly dbscanMinPoints: number = 3;
    private readonly bufferSize: number = 100; // number