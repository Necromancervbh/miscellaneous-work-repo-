import express, { Request, Response, NextFunction, Router } from 'express';
import jwt from 'jsonwebtoken';
import { DBSCAN } from 'ml-dbscan';
import { TfIdf } from 'natural';
import bodyParser from 'body-parser';

/**
 * Interface representing a single anomaly record.
 */
export interface AnomalyRecord {
    /** Unique identifier for the anomaly */
    id: string;
    /** Numerical feature vector */
    features: number[];
    /** Log snippet associated with the anomaly */
    log: string;
}

/**
 * Interface representing a cluster explanation.
 */
export interface ClusterExplanation {
    /** Cluster identifier (0‑based) */
    clusterId: number;
    /** Number of anomalies in the cluster */
    size: number;
    /** Top terms extracted from logs in the cluster */
    topTerms: string[];
}

/**
 * Configuration options for the ExplanationEngine.
 */
export interface ExplanationEngineConfig {
    /** DBSCAN epsilon distance */
    eps?: number;
    /** DBSCAN minimum points */
    minPts?: number;
    /** Number of top TF‑IDF terms to return per cluster */
    topTermsCount?: number;
    /** JWT secret used for token verification */
    jwtSecret: string;
}

/**
 * Core engine that ingests anomalies, clusters them, computes TF‑IDF,
 * and produces explanations.
 */
export class ExplanationEngine {
    private records: AnomalyRecord[] = [];
    private clusterMap: Map<number, AnomalyRecord[]> = new Map();
    private explanations: ClusterExplanation[] = [];

    private readonly eps: number;
    private readonly minPts: number;
    private readonly topTermsCount: number;

    constructor(private readonly config: ExplanationEngineConfig) {
        this.eps = config.eps ?? 0.5;
        this.minPts = config.minPts ?? 5;
        this.topTermsCount = config.topTermsCount ?? 5;
        if (!config.jwtSecret) {
            throw new Error('JWT secret must be provided in configuration.');
        }
    }

    /**
     * Validates and stores anomaly records.
     * @param records Array of anomaly records.
     */
    public ingest(records: AnomalyRecord[]): void {
        if (!Array.isArray(records)) {
            throw new TypeError('Input must be an array of AnomalyRecord objects.');
        }
        for (const rec of records) {
            this.validateRecord(rec);
            this.records.push(rec);
        }
    }

    /**
     * Executes DBSCAN clustering on the stored feature vectors.
     */
    public cluster(): void {
        if (this.records.length === 0) {
            throw new Error('No records to cluster. Call ingest() first.');
        }

        const data = this.records.map(r => r.features);
        const dbscan = new DBSCAN();
        const labels = dbscan.run(data, this.eps, this.minPts);

        // DBSCAN returns -1 for noise points.
        this.clusterMap.clear();
        labels.forEach((label, idx) => {
            if (label === -1) {
                // Ignore noise points for explanations.
                return;
            }
            if (!this.clusterMap.has(label)) {
                this.clusterMap.set(label, []);
            }
            this.clusterMap.get(label)!.push(this.records[idx]);
        });
    }

    /**
     * Computes TF‑IDF for each cluster and selects top terms.
     */
    public computeExplanations(): void {
        if (this.clusterMap.size === 0) {
            throw new Error('No clusters found. Run cluster() first.');
        }

        this.explanations = [];

        for (const [clusterId, recs] of this.clusterMap.entries()) {
            const tfidf = new TfIdf();

            // Add each log as a document.
            recs.forEach(r => tfidf.addDocument(r.log));

            // Compute term scores across the cluster.
            const termScores: Map<string, number> = new Map();

            tfidf.documents.forEach((doc, docIdx) => {
                const terms = tfidf.listTerms(docIdx);
                for (const termObj of terms) {
                    const prev = termScores.get(termObj.term) ?? 0;
                    termScores.set(termObj.term, prev + termObj.tfidf);
                }
            });

            // Sort terms by aggregated TF‑IDF score descending.
            const sortedTerms = Array.from(termScores.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, this.topTermsCount)
                .map(entry => entry[0]);

            this.explanations.push({
                clusterId,
                size: recs.length,
                topTerms: sortedTerms,
            });
        }
    }

    /**
     * Returns the computed cluster explanations.
     */
    public getExplanations(): ClusterExplanation[] {
        if (this.explanations.length === 0) {
            throw new Error('Explanations not computed. Call computeExplanations() first.');
        }
        // Return a shallow copy to prevent external mutation.
        return [...this.explanations];
    }

    /**
     * Validates a single anomaly record.
     * @param rec Record to validate.
     */
    private validateRecord(rec: AnomalyRecord): void {
        if (typeof rec !== 'object' || rec === null) {
            throw new TypeError('AnomalyRecord must be an object.');
        }
        if (typeof rec.id !== 'string' || rec.id.trim() === '') {
            throw new TypeError('AnomalyRecord.id must be a non‑empty string.');
        }
        if (!Array.isArray(rec.features) || rec.features.length === 0) {
            throw new TypeError('AnomalyRecord.features must be a non‑empty array.');
        }
        if (!rec.features.every(v => typeof v === 'number' && !Number.isNaN(v))) {
            throw new TypeError('All feature values must be valid numbers.');
        }
        if (typeof rec.log !== 'string') {
            throw new TypeError('AnomalyRecord.log must be a string.');
        }
    }
}

/**
 * JWT authentication middleware.
 */
function jwtAuth(secret: string) {
    return (req: Request, res: Response, next: NextFunction) => {
        const authHeader = req.headers['authorization'];
        if (!authHeader) {
            return res.status(401).json({ error: 'Missing Authorization header' });
        }
        const token = authHeader.split(' ')[1];
        if (!token) {
            return res.status(401).json({ error: 'Malformed Authorization header' });
        }
        jwt.verify(token, secret, (err, _decoded) => {
            if (err) {
                return res.status(403).json({ error: 'Invalid token' });
            }
            next();
        });
    };
}

/**
 * Factory function that creates an Express router exposing the explanations endpoint.
 * @param engine Initialized ExplanationEngine instance.
 * @returns Express Router.
 */
export function createExplanationRouter(engine: ExplanationEngine): Router {
    const router = express.Router();

    // Apply JSON body parsing.
    router.use(bodyParser.json());

    // Protect all routes with JWT.
    router.use(jwtAuth(engine['config'].jwtSecret));

    /**
     * POST /ingest
     * Body: { records: AnomalyRecord[] }
     * Ingests anomaly data.
     */
    router.post('/ingest', (req: Request