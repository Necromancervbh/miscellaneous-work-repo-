import express, { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import bodyParser from 'body-parser';
import { DBSCAN } from 'ml-dbscan';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

// Types
interface AnomalyVector {
    id: string;
    timestamp: number;
    values: number[];
    source: 'forecast' | 'alert' | 'heatmap';
}

interface Alert extends AnomalyVector {
    severity: number; // 0-1
    description: string;
}

interface ClusteredAlert extends Alert {
    clusterId: number | null;
    rank: number; // Bayesian posterior probability
}

// Configuration
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const DBSCAN_EPS = 0.5; // radius for DBSCAN
const DBSCAN_MIN_POINTS = 3; // minimum points to form a cluster
const PRIOR_PROBABILITY = 0.01; // prior probability of an alert being true

// Helper Functions
function validateJWT(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
        return res.status(401).json({ error: 'Missing Authorization header' });
    }
    const token = authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'Malformed Authorization header' });
    }
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid token' });
        }
        // Attach decoded payload if needed
        (req as any).user = decoded;
        next();
    });
}

/**
 * Bayesian inference posterior calculation.
 * posterior = (likelihood * prior) / evidence
 * where evidence = likelihood * prior + (1 - likelihood) * (1 - prior)
 */
function computePosterior(likelihood: number, prior: number = PRIOR_PROBABILITY): number {
    const evidence = likelihood * prior + (1 - likelihood) * (1 - prior);
    if (evidence === 0) return 0;
    return (likelihood * prior) / evidence;
}

/**
 * Simple Euclidean distance between two vectors.
 */
function euclideanDistance(a: number[], b: number[]): number {
    if (a.length !== b.length) {
        throw new Error('Vector dimensions must match');
    }
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        const diff = a[i] - b[i];
        sum += diff * diff;
    }
    return Math.sqrt(sum);
}

/**
 * Extracts feature vectors from alerts for clustering.
 */
function extractFeatureMatrix(alerts: Alert[]): number[][] {
    return alerts.map(alert => alert.values);
}

// Main Engine
export class InsightEngine {
    private app = express();
    private server?: ReturnType<typeof this.app.listen>;
    private alertStore: Map<string, Alert> = new Map();
    private clusteredAlerts: ClusteredAlert[] = [];
    private eventBus = new EventEmitter();

    constructor() {
        this.configureMiddleware();
        this.configureRoutes();
        this.registerEventHandlers();
    }

    private configureMiddleware() {
        this.app.use(bodyParser.json());

        // Rate limiting: max 100 requests per 15 minutes per IP
        const limiter = rateLimit({
            windowMs: 15 * 60 * 1000,
            max: 100,
            standardHeaders: true,
            legacyHeaders: false,
            message: { error: 'Too many requests, please try again later.' },
        });
        this.app.use(limiter);
    }

    private configureRoutes() {
        // Protected endpoint
        this.app.get('/insights', validateJWT, (req: Request, res: Response) => {
            try {
                const sorted = [...this.clusteredAlerts].sort((a, b) => b.rank - a.rank);
                res.json({ insights: sorted });
            } catch (err) {
                res.status(500).json({ error: 'Failed to retrieve insights' });
            }
        });

        // Health check (unprotected)
        this.app.get('/health', (_req, res) => {
            res.json({ status: 'ok' });
        });
    }

    private registerEventHandlers() {
        // When a new alert arrives, store it and trigger processing
        this.eventBus.on('alert', (alert: Alert) => {
            this.alertStore.set(alert.id, alert);
            this.processClusteringAndRanking();
        });

        // Forecast and heatmap streams could be used to enrich alerts in future extensions.
        // For now we just log receipt.
        this.eventBus.on('forecast', (vector: AnomalyVector) => {
            console.debug('Received forecast vector', vector.id);
        });
        this.eventBus.on('heatmap', (vector: AnomalyVector) => {
            console.debug('Received heatmap vector', vector.id);
        });
    }

    /**
     * Public API to ingest forecast vectors.
     */
    public addForecast(vector: Omit<AnomalyVector, 'id' | 'source'>) {
        const payload: AnomalyVector = {
            id: randomUUID(),
            timestamp: vector.timestamp,
            values: vector.values,
            source: 'forecast',
        };
        this.eventBus.emit('forecast', payload);
    }

    /**
     * Public API to ingest heatmap vectors.
     */
    public addHeatmap(vector: Omit<AnomalyVector, 'id' | 'source'>) {
        const payload: AnomalyVector = {
            id: randomUUID(),
            timestamp: vector.timestamp,
            values: vector.values,
            source: 'heatmap',
        };
        this.eventBus.emit('heatmap', payload);
    }

    /**
     * Public API to ingest alerts.
     */
    public addAlert(alert: Omit<Alert, 'id' | 'source'>) {
        // Input validation
        if (!Array.isArray(alert.values) || alert.values.length === 0) {
            throw new Error('Alert values must be a non‑empty array of numbers');
        }
        if (typeof alert.severity !== 'number' || alert.severity < 0 || alert.severity > 1) {
            throw new Error('Alert severity must be a number between 0 and 1');
        }
        const payload: Alert = {
            id: randomUUID(),
            timestamp: alert.timestamp,
            values: alert.values,
            source: 'alert',
            severity: alert.severity,
            description: alert.description ?? '',
        };
        this.eventBus.emit('alert', payload);
    }

    /**
     * Runs DBSCAN clustering on current alerts and computes Bayesian ranks.
     */
    private processClusteringAndRanking() {
        const alerts = Array.from(this.alertStore.values());
        if (alerts.length === 0) {
            this.clusteredAlerts = [];
            return;
        }

        // Prepare feature matrix
        const features = extractFeatureMatrix(alerts);

        // Run DBSCAN
        const dbscan = new DBSCAN();
        const clusters = dbscan.run(features, DBSCAN_EPS, DBSCAN_MIN_POINTS, euclideanDistance);

        // Map each point to its cluster id (or null for noise)
        const pointClusterMap = new Map<number, number | null>();
        clusters.forEach((cluster, idx) => {
            cluster.forEach(pointIdx => pointClusterMap.set(pointIdx, idx));
        });
        // Points not in any cluster are noise
        for (let i =