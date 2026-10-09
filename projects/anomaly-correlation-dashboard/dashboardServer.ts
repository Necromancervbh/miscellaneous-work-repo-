import http from 'http';
import url from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import LRUCache from 'lru-cache';
import PCA from 'ml-pca';
import { kmeans } from 'ml-kmeans';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

/**
 * Types
 */
interface Anomaly {
  id: string;
  timestamp: number;
  features: number[]; // Original high‑dimensional feature vector
}

interface ClusteredGroup {
  centroid: number[];
  members: Anomaly[];
}

/**
 * Configuration constants
 */
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const PCA_COMPONENTS = 2; // Reduce to 2‑D for visualization
const KMEANS_CLUSTERS = 5; // Number of clusters
const CACHE_MAX_ITEMS = 100; // Max cached result sets
const CACHE_MAX_AGE_MS = 60_000; // 1 minute cache TTL
const RATE_LIMIT_MAX_MESSAGES = 10; // Max messages per user per interval
const RATE_LIMIT_INTERVAL_MS = 1_000; // Interval for rate limiting (1 second)

/**
 * LRU cache for recent processed results.
 * Key: stringified parameters (e.g., "pca2_k5")
 * Value: ClusteredGroup[]
 */
const resultCache = new LRUCache<string, ClusteredGroup[]>({
  max: CACHE_MAX_ITEMS,
  ttl: CACHE_MAX_AGE_MS,
});

/**
 * Simple token‑bucket rate limiter per user.
 */
class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(private readonly capacity: number, private readonly refillIntervalMs: number) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  /**
   * Attempt to consume a token.
   * @returns true if allowed, false otherwise.
   */
  public tryConsume(): boolean {
    this.refillTokens();
    if (this.tokens > 0) {
      this.tokens--;
      return true;
    }
    return false;
  }

  private refillTokens(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed >= this.refillIntervalMs) {
      const refillCount = Math.floor(elapsed / this.refillIntervalMs) * this.capacity;
      this.tokens = Math.min(this.tokens + refillCount, this.capacity);
      this.lastRefill = now - (elapsed % this.refillIntervalMs);
    }
  }
}

/**
 * Map of userId -> RateLimiter
 */
const userRateLimiters = new Map<string, RateLimiter>();

/**
 * Event emitter to broadcast processed results to all connected clients.
 */
const resultEmitter = new EventEmitter();

/**
 * Mock function to retrieve recent anomalies.
 * In a real implementation this would query a database or message queue.
 */
async function fetchRecentAnomalies(limit: number = 500): Promise<Anomaly[]> {
  // Simulate async I/O latency
  await new Promise((resolve) => setTimeout(resolve, 50));

  const anomalies: Anomaly[] = [];
  for (let i = 0; i < limit; i++) {
    anomalies.push({
      id: randomUUID(),
      timestamp: Date.now() - Math.floor(Math.random() * 60_000),
      features: Array.from({ length: 10 }, () => Math.random() * 100),
    });
  }
  return anomalies;
}

/**
 * Apply PCA to reduce dimensionality.
 * @param data Matrix of shape (n_samples, n_features)
 * @returns Reduced matrix of shape (n_samples, PCA_COMPONENTS)
 */
function applyPCA(data: number[][]): number[][] {
  // PCA_COMPONENTS is small; we keep all components for variance calculation.
  const pca = new PCA(data, { center: true, scale: true });
  // Transform data to the desired number of components.
  return pca.predict(data, { nComponents: PCA_COMPONENTS }).to2DArray();
}

/**
 * Cluster data using k‑means.
 * @param reducedData Matrix after PCA (n_samples, PCA_COMPONENTS)
 * @param anomalies Original anomalies (must be same order as reducedData)
 * @returns Clustered groups.
 */
function clusterData(reducedData: number[][], anomalies: Anomaly[]): ClusteredGroup[] {
  const { clusters, centroids } = kmeans(reducedData, KMEANS_CLUSTERS);
  const groups: ClusteredGroup[] = centroids.map((centroid, idx) => ({
    centroid,
    members: [],
  }));

  clusters.forEach((clusterIdx: number, pointIdx: number) => {
    groups[clusterIdx].members.push(anomalies[pointIdx]);
  });

  return groups;
}

/**
 * Process anomalies: fetch, reduce, cluster, and cache.
 * @returns ClusteredGroup[]
 */
async function processAnomalies(): Promise<ClusteredGroup[]> {
  const cacheKey = `pca${PCA_COMPONENTS}_k${KMEANS_CLUSTERS}`;
  const cached = resultCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const anomalies = await fetchRecentAnomalies();
  if (anomalies.length === 0) {
    return [];
  }

  const featureMatrix = anomalies.map((a) => a.features);
  // Input validation: ensure matrix is non‑empty and rectangular
  if (featureMatrix.length === 0 || featureMatrix[0].length === 0) {
    throw new Error('Invalid feature matrix for PCA.');
  }

  const reduced = applyPCA(featureMatrix);
  const groups = clusterData(reduced, anomalies);
  resultCache.set(cacheKey, groups);
  return groups;
}

/**
 * Periodically compute results and emit to listeners.
 */
function startResultComputationLoop(intervalMs: number = 5_000): void {
  setInterval(async () => {
    try {
      const groups = await processAnomalies();
      resultEmitter.emit('update', groups);
    } catch (err) {
      console.error('Error processing anomalies:', err);
    }
  }, intervalMs);
}

/**
 * Validate and extract userId from the WebSocket connection URL.
 * Expected format: ws://host:port?userId=someId
 */
function extractUserId(requestUrl: string): string | null {
  try {
    const parsed = url.parse(requestUrl, true);
    const userId = parsed.query.userId;
    if (typeof userId === 'string' && userId.trim().length > 0) {
      return userId.trim();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Initialize the HTTP server and attach a WebSocket server.
 */
export function startDashboardServer(): void {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Anomaly Correlation Dashboard WebSocket server is running.\n');
  });

  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws: WebSocket, request: http.IncomingMessage) => {
    const userId = extractUserId(request.url ?? '');
    if (!userId) {
      ws