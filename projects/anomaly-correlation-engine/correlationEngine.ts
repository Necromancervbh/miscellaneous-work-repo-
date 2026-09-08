import express, { Request, Response, NextFunction } from 'express';
import { Pool, QueryResult } from 'pg';
import jwt from 'jsonwebtoken';
import LRUCache from 'lru-cache';
import { EventEmitter } from 'events';
import { URLSearchParams } from 'url';
import * as dotenv from 'dotenv';
import { createServer } from 'http';
import { randomUUID } from 'crypto';

dotenv.config();

/**
 * Kalman filter for 1‑D signal smoothing.
 * Equations:
 *   Predict:   x̂ₖ|ₖ₋₁ = x̂ₖ₋₁
 *              Pₖ|ₖ₋₁ = Pₖ₋₁ + Q
 *   Update:    Kₖ = Pₖ|ₖ₋₁ / (Pₖ|ₖ₋₁ + R)
 *              x̂ₖ = x̂ₖ|ₖ₋₁ + Kₖ (zₖ - x̂ₖ|ₖ₋₁)
 *              Pₖ = (1 - Kₖ) Pₖ|ₖ₋₁
 */
class KalmanFilter1D {
    private estimate: number;
    private errorCovariance: number;
    private readonly processVariance: number;
    private readonly measurementVariance: number;

    constructor(initialEstimate: number, initialErrorCovariance: number, processVariance: number, measurementVariance: number) {
        this.estimate = initialEstimate;
        this.errorCovariance = initialErrorCovariance;
        this.processVariance = processVariance;
        this.measurementVariance = measurementVariance;
    }

    public filter(measurement: number): number {
        // Predict
        const predEstimate = this.estimate;
        const predErrorCov = this.errorCovariance + this.processVariance;

        // Update
        const kalmanGain = predErrorCov / (predErrorCov + this.measurementVariance);
        this.estimate = predEstimate + kalmanGain * (measurement - predEstimate);
        this.errorCovariance = (1 - kalmanGain) * predErrorCov;

        return this.estimate;
    }
}

/**
 * Compute Pearson correlation coefficient between two equal‑length numeric arrays.
 * Formula:
 *   r = Σ((xᵢ - μₓ)(yᵢ - μ_y)) / sqrt( Σ(xᵢ - μₓ)² * Σ(yᵢ - μ_y)² )
 */
function pearsonCorrelation(x: number[], y: number[]): number | null {
    if (x.length !== y.length || x.length === 0) {
        return null;
    }
    const n = x.length;
    const meanX = x.reduce((a, b) => a + b, 0) / n;
    const meanY = y.reduce((a, b) => a + b, 0) / n;

    let numerator = 0;
    let denomX = 0;
    let denomY = 0;

    for (let i = 0; i < n; i++) {
        const dx = x[i] - meanX;
        const dy = y[i] - meanY;
        numerator += dx * dy;
        denomX += dx * dx;
        denomY += dy * dy;
    }

    const denominator = Math.sqrt(denomX * denomY);
    if (denominator === 0) {
        return null;
    }
    return numerator / denominator;
}

/**
 * PostgreSQL connection pool.
 */
const pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

/**
 * Ensure the correlations table exists.
 */
async function initDb(): Promise<void> {
    const createTableQuery = `
        CREATE TABLE IF NOT EXISTS correlations (
            id UUID PRIMARY KEY,
            metric_a TEXT NOT NULL,
            metric_b TEXT NOT NULL,
            correlation DOUBLE PRECISION NOT NULL,
            computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_correlations_metrics ON correlations(metric_a, metric_b);
    `;
    await pgPool.query(createTableQuery);
}

/**
 * Store top correlated metric pairs.
 */
async function storeTopCorrelations(pairs: Array<{ metricA: string; metricB: string; correlation: number }>): Promise<void> {
    const client = await pgPool.connect();
    try {
        await client.query('BEGIN');
        const insertText = `
            INSERT INTO correlations (id, metric_a, metric_b, correlation)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (metric_a, metric_b) DO UPDATE
            SET correlation = EXCLUDED.correlation,
                computed_at = NOW();
        `;
        for (const pair of pairs) {
            const id = randomUUID();
            await client.query(insertText, [id, pair.metricA, pair.metricB, pair.correlation]);
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error storing correlations:', err);
        throw err;
    } finally {
        client.release();
    }
}

/**
 * LRU cache for recent correlation queries.
 */
const correlationCache = new LRUCache<string, number>({
    max: 500,
    ttl: 1000 * 60 * 5, // 5 minutes
});

/**
 * JWT authentication middleware.
 */
function jwtAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Missing or malformed Authorization header' });
        return;
    }
    const token = authHeader.slice(7);
    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET as string);
        (req as any).user = payload;
        next();
    } catch (err) {
        res.status(401).json({ error: 'Invalid token' });
    }
}

/**
 * Core engine handling streaming ingestion and correlation computation.
 */
class CorrelationEngine extends EventEmitter {
    private readonly seriesMap: Map<string, number[]> = new Map();
    private readonly kalmanFilters: Map<string, KalmanFilter1D> = new Map();
    private readonly windowSize: number;
    private readonly topK: number;

    constructor(windowSize = 100, topK = 10) {
        super();
        this.windowSize = windowSize;
        this.topK = topK;
    }

    /**
     * Ingest a single data point.
     * Expected payload:
     * {
     *   metric: string,
     *   timestamp: number (ms epoch),
     *   value: number
     * }
     */
    public ingest(payload: unknown): void {
        if (typeof payload !== 'object' || payload === null) {
            this.emit('error', new Error('Invalid payload type'));
            return;
        }
        const { metric, value } = payload as { metric?: unknown; value?: unknown };
        if (typeof metric !== 'string' || typeof value !== 'number') {
            this.emit('error', new Error('Payload missing required fields'));
            return;
        }

        // Initialize Kalman filter if needed
        if (!this.kalmanFilters.has(metric)) {
            const kf = new KalmanFilter1D(value, 1, 1e-3, 1e-2);
            this.kalmanFilters.set(metric, kf);
        }

        const filtered = this.kalmanFilters.get(metric)!.filter(value);

        // Maintain sliding window
        const series = this.seriesMap.get(metric) ?? [];
        series.push(filtered);
        if (series.length > this.windowSize) {
            series.shift();
        }
        this.seriesMap.set(metric