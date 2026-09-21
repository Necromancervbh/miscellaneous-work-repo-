import { createServer, Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import PCA from 'ml-pca';
import DBSCAN from 'ml-dbscan';

/**
 * Interface representing a single time‑series data point.
 */
export interface DataPoint {
    /** ISO‑8601 timestamp string */
    timestamp: string;
    /** Numeric values for each dimension */
    values: number[];
}

/**
 * Simple multi‑dimensional Kalman filter.
 *
 * Model:
 *   xₖ = xₖ₋₁          (state transition, assuming constant value)
 *   zₖ = xₖ + vₖ       (measurement with noise vₖ)
 *
 * Equations:
 *   Predict:   x̂ₖ⁻ = x̂ₖ₋₁
 *              Pₖ⁻ = Pₖ₋₁ + Q
 *   Update:    Kₖ = Pₖ⁻ / (Pₖ⁻ + R)
 *              x̂ₖ = x̂ₖ⁻ + Kₖ (zₖ - x̂ₖ⁻)
 *              Pₖ = (1 - Kₖ) Pₖ⁻
 *
 * Q – process noise covariance, R – measurement noise covariance.
 */
class KalmanFilter {
    private state: number[];
    private covariance: number[];
    private readonly processNoise: number;
    private readonly measurementNoise: number;
    private readonly dim: number;

    constructor(dim: number, processNoise = 1e-5, measurementNoise = 1e-2) {
        if (dim <= 0) {
            throw new Error('Dimension must be a positive integer');
        }
        this.dim = dim;
        this.state = new Array(dim).fill(0);
        this.covariance = new Array(dim).fill(1);
        this.processNoise = processNoise;
        this.measurementNoise = measurementNoise;
    }

    /**
     * Apply the filter to a new measurement vector.
     * @param measurement Array of numbers with length equal to filter dimension.
     * @returns Smoothed estimate vector.
     */
    public filter(measurement: number[]): number[] {
        if (!Array.isArray(measurement) || measurement.length !== this.dim) {
            throw new Error('Measurement vector size mismatch');
        }

        const estimate = new Array(this.dim);
        for (let i = 0; i < this.dim; i++) {
            // Predict step
            const predState = this.state[i];
            const predCov = this.covariance[i] + this.processNoise;

            // Update step
            const kalmanGain = predCov / (predCov + this.measurementNoise);
            const updatedState = predState + kalmanGain * (measurement[i] - predState);
            const updatedCov = (1 - kalmanGain) * predCov;

            // Store results
            this.state[i] = updatedState;
            this.covariance[i] = updatedCov;
            estimate[i] = updatedState;
        }
        return estimate;
    }
}

/**
 * Core streaming pipeline handling ingestion, smoothing, dimensionality reduction,
 * and clustering.
 */
export class MLStreamingPipeline extends EventEmitter {
    private readonly batchSize: number;
    private readonly dim: number;
    private readonly kalman: KalmanFilter;
    private buffer: number[][] = [];

    constructor(dim: number, batchSize = 100) {
        super();
        if (dim <= 0) {
            throw new Error('Dimension must be a positive integer');
        }
        if (batchSize <= 0) {
            throw new Error('Batch size must be a positive integer');
        }
        this.dim = dim;
        this.batchSize = batchSize;
        this.kalman = new KalmanFilter(dim);
    }

    /**
     * Ingest a raw data point, apply Kalman smoothing and store for batch processing.
     * @param point Raw data point.
     */
    public ingest(point: DataPoint): void {
        try {
            this.validateDataPoint(point);
            const smoothed = this.kalman.filter(point.values);
            this.buffer.push(smoothed);
            if (this.buffer.length >= this.batchSize) {
                const batch = this.buffer.splice(0, this.batchSize);
                this.processBatch(batch);
            }
        } catch (err) {
            this.emit('error', err);
        }
    }

    /**
     * Validate incoming data point structure.
     * @param point Data point to validate.
     */
    private validateDataPoint(point: DataPoint): void {
        if (typeof point !== 'object' || point === null) {
            throw new Error('Data point must be an object');
        }
        if (typeof point.timestamp !== 'string' || isNaN(Date.parse(point.timestamp))) {
            throw new Error('Invalid or missing timestamp');
        }
        if (!Array.isArray(point.values) || point.values.length !== this.dim) {
            throw new Error(`Values must be an array of length ${this.dim}`);
        }
        for (const v of point.values) {
            if (typeof v !== 'number' || !Number.isFinite(v)) {
                throw new Error('All values must be finite numbers');
            }
        }
    }

    /**
     * Process a full batch: PCA → DBSCAN → emit results.
     * @param batch Array of smoothed vectors.
     */
    private processBatch(batch: number[][]): void {
        try {
            // PCA
            const pca = new PCA(batch, { center: true, scale: true });
            const reduced = pca.predict(batch, { nComponents: Math.min(this.dim, 3) });

            // DBSCAN
            const dbscan = new DBSCAN();
            const epsilon = 0.5; // radius; may be tuned
            const minPoints = 5; // minimum cluster size
            const clusters = dbscan.run(reduced, epsilon, minPoints);

            // Prepare result payload
            const result = {
                timestamp: new Date().toISOString(),
                clusters: clusters.map((clusterIndices: number[]) => ({
                    size: clusterIndices.length,
                    points: clusterIndices.map(idx => ({
                        original: batch[idx],
                        reduced: reduced[idx]
                    }))
                })),
                noise: dbscan.noise.map((idx: number) => ({
                    original: batch[idx],
                    reduced: reduced[idx]
                }))
            };

            this.emit('result', result);
        } catch (err) {
            this.emit('error', err);
        }
    }
}

/**
 * Starts a WebSocket server exposing the streaming pipeline.
 * @param port TCP port for the WebSocket server.
 * @param dim Dimensionality of incoming data vectors.
 * @param batchSize Number of points per processing batch.
 * @returns The underlying HTTP server (useful for graceful shutdown).
 */
export function startWebSocketServer(port: number, dim: number, batchSize = 100): HttpServer {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error