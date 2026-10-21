import WebSocket from 'ws';
import { Redis } from 'ioredis';
import { PCA } from 'ml-pca';
import DBSCAN from 'density-clustering';
import { EventEmitter } from 'events';

/**
 * KalmanFilter implements a simple linear Kalman filter for multi‑dimensional data.
 *
 * State transition:   xₖ = xₖ₋₁
 * Observation model:  zₖ = xₖ + vₖ
 *
 * Equations:
 *   Predict:   x̂ₖ|ₖ₋₁ = x̂ₖ₋₁|ₖ₋₁
 *              Pₖ|ₖ₋₁ = Pₖ₋₁|ₖ₋₁ + Q
 *   Update:    Kₖ = Pₖ|ₖ₋₁ / (Pₖ|ₖ₋₁ + R)
 *              x̂ₖ|ₖ = x̂ₖ|ₖ₋₁ + Kₖ (zₖ - x̂ₖ|ₖ₋₁)
 *              Pₖ|ₖ = (1 - Kₖ) Pₖ|ₖ₋₁
 *
 * Q – process noise covariance (scalar, applied per dimension)
 * R – measurement noise covariance (scalar, applied per dimension)
 */
class KalmanFilter {
  private readonly dim: number;
  private readonly q: number;
  private readonly r: number;
  private state: number[];
  private covariance: number[];

  constructor(dim: number, processNoise = 1e-5, measurementNoise = 1e-2) {
    if (!Number.isInteger(dim) || dim <= 0) {
      throw new Error('KalmanFilter: dim must be a positive integer');
    }
    this.dim = dim;
    this.q = processNoise;
    this.r = measurementNoise;
    this.state = new Array(dim).fill(0);
    this.covariance = new Array(dim).fill(1);
  }

  /**
   * Apply the filter to a new observation vector.
   * @param measurement numeric array of length `dim`
   * @returns filtered state vector
   */
  filter(measurement: number[]): number[] {
    if (!Array.isArray(measurement) || measurement.length !== this.dim) {
      throw new Error(`KalmanFilter: measurement must be an array of length ${this.dim}`);
    }

    // Predict step
    const predCov = this.covariance.map(c => c + this.q);

    // Update step per dimension
    const newState = new Array(this.dim);
    const newCov = new Array(this.dim);
    for (let i = 0; i < this.dim; i++) {
      const k = predCov[i] / (predCov[i] + this.r); // Kalman gain
      newState[i] = this.state[i] + k * (measurement[i] - this.state[i]);
      newCov[i] = (1 - k) * predCov[i];
    }

    this.state = newState;
    this.covariance = newCov;
    return [...this.state];
  }
}

/**
 * IngestionPipeline consumes JSON messages from a WebSocket, filters noise,
 * reduces dimensionality, clusters residuals, and stores enriched records in Redis.
 *
 * Expected incoming message format:
 *   {
 *     id: string,
 *     timestamp: number (epoch ms),
 *     payload: number[]   // numeric vector
 *   }
 */
export class IngestionPipeline extends EventEmitter {
  private readonly wsUrl: string;
  private readonly redisClient: Redis;
  private readonly ws?: WebSocket;
  private readonly kalman: KalmanFilter;
  private readonly pca: PCA;
  private readonly dbscan: DBSCAN.DBSCAN;
  private readonly residualBuffer: number[][] = [];
  private readonly maxBufferSize: number;
  private readonly redisListKey = 'ingestion:records';
  private readonly maxCacheSize: number;
  private readonly recordTTLSeconds: number;

  /**
   * @param wsUrl WebSocket endpoint URL.
   * @param redisClient Initialized ioredis client.
   * @param options optional configuration.
   */
  constructor(
    wsUrl: string,
    redisClient: Redis,
    options?: {
      kalmanDim?: number;
      kalmanProcessNoise?: number;
      kalmanMeasurementNoise?: number;
      pcaComponents?: number;
      dbscanEps?: number;
      dbscanMinPts?: number;
      maxBufferSize?: number;
      maxCacheSize?: number;
      recordTTLSeconds?: number;
    }
  ) {
    super();

    if (typeof wsUrl !== 'string' || wsUrl.trim() === '') {
      throw new Error('IngestionPipeline: wsUrl must be a non‑empty string');
    }
    this.wsUrl = wsUrl;
    this.redisClient = redisClient;

    const kalmanDim = options?.kalmanDim ?? 0; // will be set on first message
    this.kalman = new KalmanFilter(kalmanDim || 1, options?.kalmanProcessNoise, options?.kalmanMeasurementNoise);

    const pcaComponents = options?.pcaComponents ?? 2;
    this.pca = new PCA([], { center: true, scale: true, nComponents: pcaComponents });

    this.dbscan = new DBSCAN.DBSCAN();
    this.maxBufferSize = options?.maxBufferSize ?? 500;
    this.maxCacheSize = options?.maxCacheSize ?? 1000;
    this.recordTTLSeconds = options?.recordTTLSeconds ?? 3600; // 1 hour
  }

  /**
   * Starts the WebSocket connection and begins processing.
   */
  public start(): void {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.on('open', () => {
      this.emit('connected');
    });

    ws.on('message', (data: WebSocket.Data) => {
      this.handleMessage(data).catch(err => this.emit('error', err));
    });

    ws.on('error', err => {
      this.emit('error', err);
    });

    ws.on('close', (code, reason) => {
      this.emit('closed', { code, reason });
    });
  }

  /**
   * Gracefully stops the pipeline.
   */
  public async stop(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.terminate();
    }
    await this.redisClient.quit();
    this.emit('stopped');
  }

  /**
   * Parses, validates, and processes a single WebSocket message.
   */
  private async handleMessage(raw: WebSocket.Data): Promise<void> {
    let msg: unknown;
    try {
      const str = typeof raw === 'string' ? raw : raw.toString('utf8');
      msg = JSON.parse(str);
    } catch (e) {
      throw new Error('Invalid JSON received from WebSocket');
    }

    if (!this.isValidRecord(msg)) {
      throw new Error('Received message does not conform to expected schema');
    }

    const record = msg as IncomingRecord;
    const filtered = this.applyKalman(record.payload);
    const pcaResult = this.applyPCA(filtered);
    const residual = this.computeResidual(filtered, pcaResult.reconstructed);
    this.bufferResidual(residual);
    const clusterLabel = this.performClustering();

    const enriched: EnrichedRecord = {
      id: record.id,
      timestamp: record.timestamp,
      original: record.payload,
      filtered,
      pca: pcaResult.scores,
      residual,
      cluster: clusterLabel