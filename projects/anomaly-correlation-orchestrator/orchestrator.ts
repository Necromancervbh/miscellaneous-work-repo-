import { EventEmitter } from 'events';
import Redis from 'ioredis';
import WebSocket, { Server as WebSocketServer } from 'ws';
import { DBSCAN } from 'ml-dbscan';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Interface representing the prediction engine.
 * It must provide forecast residuals for a given time window.
 */
export interface PredictionEngine {
  /**
   * Retrieves forecast residuals.
   * @param start ISO string start time.
   * @param end   ISO string end time.
   * @returns Promise resolving to an array of residual objects.
   */
  getForecastResiduals(start: string, end: string): Promise<Residual[]>;
}

/**
 * Residual data point.
 */
export interface Residual {
  /** Timestamp of the residual in ISO format. */
  timestamp: string;
  /** Numeric residual value (observed - forecast). */
  value: number;
}

/**
 * Cluster result emitted to the dashboard.
 */
export interface ClusterResult {
  /** Unique identifier for the clustering run. */
  runId: string;
  /** Timestamp of the clustering run. */
  runAt: string;
  /** Array of clusters, each cluster is an array of residual indices. */
  clusters: number[][];
  /** Noise points indices (points not belonging to any cluster). */
  noise: number[];
}

/**
 * Orchestrator service that:
 * 1. Consumes the prediction engine.
 * 2. Runs DBSCAN clustering on residuals.
 * 3. Caches results in Redis with LRU eviction.
 * 4. Broadcasts results via WebSocket.
 */
export class AnomalyOrchestrator extends EventEmitter {
  private readonly redis: Redis.Redis;
  private readonly wsServer: WebSocketServer;
  private readonly predictionEngine: PredictionEngine;
  private readonly cacheTTLSeconds: number;
  private readonly dbscanEpsilon: number;
  private readonly dbscanMinPts: number;

  /**
   * @param predictionEngine Instance implementing PredictionEngine.
   * @param redisOptions Options for Redis connection.
   * @param wsPort Port on which the WebSocket server will listen.
   * @param options Optional configuration.
   */
  constructor(
    predictionEngine: PredictionEngine,
    redisOptions: Redis.RedisOptions,
    wsPort: number,
    options?: {
      cacheTTLSeconds?: number;
      dbscanEpsilon?: number;
      dbscanMinPts?: number;
    }
  ) {
    super();

    if (!predictionEngine) {
      throw new Error('PredictionEngine instance is required.');
    }
    this.predictionEngine = predictionEngine;

    this.redis = new Redis(redisOptions);
    this.wsServer = new WebSocketServer({ port: wsPort });

    this.cacheTTLSeconds = options?.cacheTTLSeconds ?? 300; // default 5 minutes
    this.dbscanEpsilon = options?.dbscanEpsilon ?? 0.5; // default epsilon
    this.dbscanMinPts = options?.dbscanMinPts ?? 5; // default min points

    this.wsServer.on('connection', (socket) => {
      socket.on('error', (err) => this.emit('error', err));
    });

    this.wsServer.on('error', (err) => this.emit('error', err));
  }

  /**
   * Executes the full pipeline for a given time window.
   * @param start ISO string start time.
   * @param end   ISO string end time.
   */
  public async run(start: string, end: string): Promise<void> {
    try {
      this.validateISODate(start, 'start');
      this.validateISODate(end, 'end');

      const residuals = await this.predictionEngine.getForecastResiduals(start, end);
      if (!Array.isArray(residuals) || residuals.length === 0) {
        throw new Error('Prediction engine returned no residuals.');
      }

      const points = residuals.map((r) => [r.value]); // DBSCAN expects an array of numeric vectors

      // DBSCAN clustering
      // Distance metric: Euclidean distance d(p,q) = sqrt( Σ_i (p_i - q_i)^2 )
      const dbscan = new DBSCAN();
      const clusters = dbscan.run(points, this.dbscanEpsilon, this.dbscanMinPts);
      const noise = dbscan.noise;

      const runId = this.generateRunId();
      const result: ClusterResult = {
        runId,
        runAt: new Date().toISOString(),
        clusters,
        noise,
      };

      await this.cacheResult(runId, result);
      this.broadcastResult(result);
    } catch (err) {
      this.emit('error', err);
      throw err;
    }
  }

  /**
   * Retrieves a cached clustering result by runId.
   * @param runId Identifier of the clustering run.
   * @returns ClusterResult or null if not found.
   */
  public async getCachedResult(runId: string): Promise<ClusterResult | null> {
    if (!runId || typeof runId !== 'string') {
      throw new Error('Invalid runId.');
    }
    const raw = await this.redis.get(this.cacheKey(runId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ClusterResult;
    } catch {
      // Corrupted cache entry; delete it.
      await this.redis.del(this.cacheKey(runId));
      return null;
    }
  }

  /**
   * Gracefully shuts down connections.
   */
  public async shutdown(): Promise<void> {
    await this.redis.quit();
    this.wsServer.close();
  }

  /**
   * Broadcasts a clustering result to all connected WebSocket clients.
   * @param result ClusterResult to broadcast.
   */
  private broadcastResult(result: ClusterResult): void {
    const payload = JSON.stringify({ type: 'clusterResult', data: result });
    this.wsServer.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload, (err) => {
          if (err) this.emit('error', err);
        });
      }
    });
  }

  /**
   * Caches the clustering result in Redis.
   * @param runId Identifier for the run.
   * @param result Result to cache.
   */
  private async cacheResult(runId: string, result: ClusterResult): Promise<void> {
    const key = this.cacheKey(runId);
    const value = JSON.stringify(result);
    // Using SET with EX to enforce TTL; Redis LRU policy should be configured server-side.
    await this.redis.set(key, value, 'EX', this.cacheTTLSeconds);
  }

  /**
   * Generates a deterministic cache key for a given runId.
   */
  private cacheKey(runId: string): string {
    return `clusterResult:${runId}`;
  }

  /**
   * Generates a unique identifier for each clustering run.
   */
  private generateRunId(): string {
    // Simple UUID v4 implementation without external deps
    const bytes = cryptoRandomBytes(16);
    // Set version to 4
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    // Set variant to RFC4122
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.substr(0, 8)}-${hex.substr(8, 4)}-${hex.substr(12, 4)}-${hex.substr(16, 4)}-${hex.substr(20, 12)}`;
  }

  /**
   * Validates that a string is a proper ISO 8601 date.
   */
  private validateISODate(dateStr: string, name: string): void {
    if (typeof dateStr