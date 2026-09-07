import { EventEmitter } from 'events';
import WebSocket, { Server as WebSocketServer } from 'ws';
import LRUCache from 'lru-cache';
import { setIntervalAsync, clearIntervalAsync } from 'set-interval-async/dynamic';

/**
 * Types and Interfaces
 */
export interface AnomalyEvent {
    id: string;
    timestamp: number; // epoch ms
    features: Record<string, number>;
    severity: number; // raw severity score, e.g., 0-100
}

export interface ScoredEvent extends AnomalyEvent {
    bayesianScore: number; // probability score [0,1]
}

export interface ClusteredEvent extends ScoredEvent {
    clusterId: number;
}

export interface Notification {
    eventId: string;
    clusterId: number;
    bayesianScore: number;
    timestamp: number;
}

/**
 * Bayesian Scorer
 * Computes P(anomaly | features) using a naive Bayes approximation.
 * For simplicity we assume independent Gaussian likelihoods.
 *
 * Formula:
 *   P(A|X) = ( P(A) * Π_i P(x_i | A) ) / Z
 *   where Z is a normalizing constant (ignored for ranking).
 */
class BayesianScorer {
    private prior: number; // P(A), prior probability of anomaly
    private featureStats: Map<string, { mean: number; variance: number }>;

    constructor(prior = 0.01) {
        this.prior = prior;
        this.featureStats = new Map();
    }

    /**
     * Update feature statistics with a new labeled example.
     * In production this would be fed from historical data.
     */
    public updateFeatureStats(feature: string, value: number): void {
        const stats = this.featureStats.get(feature);
        if (!stats) {
            this.featureStats.set(feature, { mean: value, variance: 1 });
            return;
        }
        const n = 1; // placeholder for count; in real implementation maintain count
        const delta = value - stats.mean;
        const newMean = stats.mean + delta / (n + 1);
        const newVar = ((n - 1) * stats.variance + delta * (value - newMean)) / n;
        this.featureStats.set(feature, { mean: newMean, variance: Math.max(newVar, 1e-6) });
    }

    private gaussianPdf(x: number, mean: number, variance: number): number {
        const denom = Math.sqrt(2 * Math.PI * variance);
        const num = Math.exp(-((x - mean) ** 2) / (2 * variance));
        return num / denom;
    }

    public score(event: AnomalyEvent): number {
        let likelihood = 1;
        for (const [key, value] of Object.entries(event.features)) {
            const stats = this.featureStats.get(key);
            if (!stats) {
                // If we have no stats, assume uniform likelihood
                continue;
            }
            likelihood *= this.gaussianPdf(value, stats.mean, stats.variance);
        }
        const posterior = this.prior * likelihood;
        // Clamp to [0,1] for safety
        return Math.min(Math.max(posterior, 0), 1);
    }
}

/**
 * Simple K-Means Clusterer
 * Clusters events based on a vector composed of [bayesianScore, severity].
 */
class KMeansClusterer {
    private k: number;
    private maxIterations: number;
    private centroids: number[][] = [];

    constructor(k = 3, maxIterations = 100) {
        if (k <= 0) throw new Error('Number of clusters k must be positive');
        this.k = k;
        this.maxIterations = maxIterations;
    }

    private distance(a: number[], b: number[]): number {
        return Math.sqrt(a.reduce((sum, val, idx) => sum + (val - b[idx]) ** 2, 0));
    }

    private initializeCentroids(data: number[][]): void {
        // Simple random initialization
        const shuffled = data.slice().sort(() => 0.5 - Math.random());
        this.centroids = shuffled.slice(0, this.k).map(point => point.slice());
    }

    private assignClusters(data: number[][]): number[] {
        return data.map(point => {
            let minDist = Infinity;
            let clusterIdx = -1;
            this.centroids.forEach((centroid, idx) => {
                const dist = this.distance(point, centroid);
                if (dist < minDist) {
                    minDist = dist;
                    clusterIdx = idx;
                }
            });
            return clusterIdx;
        });
    }

    private recomputeCentroids(data: number[][], assignments: number[]): void {
        const sums = Array.from({ length: this.k }, () => Array(data[0].length).fill(0));
        const counts = Array(this.k).fill(0);
        data.forEach((point, i) => {
            const cluster = assignments[i];
            counts[cluster] += 1;
            point.forEach((val, dim) => {
                sums[cluster][dim] += val;
            });
        });
        this.centroids = sums.map((sum, idx) => {
            if (counts[idx] === 0) return this.centroids[idx]; // keep old centroid if empty
            return sum.map(v => v / counts[idx]);
        });
    }

    public fit(events: ScoredEvent[]): number[] {
        if (events.length === 0) return [];

        const data = events.map(e => [e.bayesianScore, e.severity]);
        this.initializeCentroids(data);
        let assignments: number[] = [];

        for (let iter = 0; iter < this.maxIterations; iter++) {
            const newAssignments = this.assignClusters(data);
            if (assignments.length && newAssignments.every((c, i) => c === assignments[i])) {
                break; // convergence
            }
            assignments = newAssignments;
            this.recomputeCentroids(data, assignments);
        }
        return assignments;
    }

    public predict(event: ScoredEvent): number {
        const point = [event.bayesianScore, event.severity];
        let minDist = Infinity;
        let clusterIdx = -1;
        this.centroids.forEach((centroid, idx) => {
            const dist = this.distance(point, centroid);
            if (dist < minDist) {
                minDist = dist;
                clusterIdx = idx;
            }
        });
        return clusterIdx;
    }
}

/**
 * LRU Cache for processed event IDs
 */
class ProcessedCache {
    private cache: LRUCache<string, true>;

    constructor(maxSize = 1000) {
        this.cache = new LRUCache<string, true>({ max: maxSize });
    }

    public has(id: string): boolean {
        return this.cache.has(id);
    }

    public add(id: string): void {
        this.cache.set(id, true);
    }
}

/**
 * Token Bucket Rate Limiter
 * Allows maxTokens per intervalMs.
 */
class RateLimiter {
    private maxTokens: number;
    private intervalMs: number;
    private tokens: number;
    private lastRefill: number;

    constructor(maxTokens: number, intervalMs: number) {
        if (maxTokens <= 0 || intervalMs <= 0) throw new Error('Invalid rate limiter parameters');
        this.maxTokens = maxTokens;
        this.intervalMs = intervalMs;
        this.tokens = maxTokens;
        this.lastRefill = Date.now();
    }

    private