import express, { Request, Response, NextFunction, Router } from 'express';
import axios, { AxiosResponse } from 'axios';
import PCA from 'ml-pca';
import DBSCAN from 'ml-dbscan';
import { mean, variance, sqrt, log } from 'mathjs';

// Types
interface AnomalyEvent {
    id: string;
    timestamp: string; // ISO string
    source: string; // incident | management | dashboard
    features: number[]; // numeric feature vector
    [key: string]: any; // additional metadata
}

interface ProcessedEvent extends AnomalyEvent {
    pcaComponents: number[];
    cluster: number; // -1 for noise
    bayesianScore: number;
}

// Configuration (could be moved to a separate config file)
const SERVICE_ENDPOINTS = {
    incident: process.env.INCIDENT_SERVICE_URL,
    management: process.env.MANAGEMENT_SERVICE_URL,
    dashboard: process.env.DASHBOARD_SERVICE_URL,
};

if (!SERVICE_ENDPOINTS.incident || !SERVICE_ENDPOINTS.management || !SERVICE_ENDPOINTS.dashboard) {
    throw new Error('Missing required service endpoint environment variables.');
}

// Helper Functions
async function fetchEventsFromService(url: string, source: string): Promise<AnomalyEvent[]> {
    try {
        const response: AxiosResponse = await axios.get(url, { timeout: 5000 });
        if (!Array.isArray(response.data)) {
            throw new Error(`Invalid response format from ${source} service`);
        }
        // Validate each event
        const events: AnomalyEvent[] = response.data.map((item: any, idx: number) => {
            if (typeof item.id !== 'string' ||
                typeof item.timestamp !== 'string' ||
                !Array.isArray(item.features) ||
                !item.features.every((v: any) => typeof v === 'number')) {
                throw new Error(`Invalid event format at index ${idx} from ${source} service`);
            }
            return {
                id: item.id,
                timestamp: item.timestamp,
                source,
                features: item.features,
                ...item,
            };
        });
        return events;
    } catch (err) {
        const error = err as Error;
        console.error(`Failed to fetch events from ${source} service at ${url}: ${error.message}`);
        throw error;
    }
}

/**
 * Perform PCA on the feature matrix.
 * Retains enough components to explain at least 95% of variance.
 * @param data Matrix of shape [nSamples, nFeatures]
 * @returns transformed matrix of shape [nSamples, nComponents]
 */
function applyPCA(data: number[][]): number[][] {
    const pca = new PCA(data, { center: true, scale: true });
    const cumulativeVariance = pca.getCumulativeVariance();
    // Find minimal number of components covering 95% variance
    const componentsToKeep = cumulativeVariance.findIndex(v => v >= 0.95) + 1 || cumulativeVariance.length;
    // @ts-ignore – getEigenvectors returns a matrix
    const eigenvectors = pca.getEigenvectors().slice(0, componentsToKeep);
    const transformed = pca.predict(data, { nComponents: componentsToKeep });
    return transformed as unknown as number[][];
}

/**
 * Cluster data using DBSCAN.
 * @param data Matrix of shape [nSamples, nFeatures]
 * @param eps Neighborhood radius
 * @param minPoints Minimum points to form a cluster
 * @returns Array of cluster labels (-1 for noise)
 */
function applyDBSCAN(data: number[][], eps = 0.5, minPoints = 5): number[] {
    const dbscan = new DBSCAN();
    const clusters = dbscan.run(data, eps, minPoints);
    const labels = new Array(data.length).fill(-1);
    clusters.forEach((cluster, idx) => {
        cluster.forEach(pointIdx => {
            labels[pointIdx] = idx;
        });
    });
    return labels;
}

/**
 * Compute Bayesian anomaly score for each point assuming a multivariate Gaussian.
 * Score = -log(p(x)) where p(x) is the probability density.
 * @param data Matrix of shape [nSamples, nFeatures]
 * @returns Array of scores (higher = more anomalous)
 */
function computeBayesianScores(data: number[][]): number[] {
    const n = data.length;
    const dim = data[0].length;

    // Compute mean vector μ
    const mu = new Array(dim).fill(0);
    data.forEach(row => {
        row.forEach((val, i) => {
            mu[i] += val;
        });
    });
    for (let i = 0; i < dim; i++) {
        mu[i] /= n;
    }

    // Compute covariance matrix Σ (diagonal approximation for simplicity)
    const sigmaSq = new Array(dim).fill(0);
    data.forEach(row => {
        row.forEach((val, i) => {
            const diff = val - mu[i];
            sigmaSq[i] += diff * diff;
        });
    });
    for (let i = 0; i < dim; i++) {
        sigmaSq[i] = sigmaSq[i] / (n - 1) || 1e-6; // avoid zero variance
    }

    // Compute scores
    const scores: number[] = data.map(row => {
        // Multivariate Gaussian with diagonal Σ:
        // p(x) = (2π)^(-d/2) * |Σ|^{-1/2} * exp(-0.5 * Σ_i ((x_i-μ_i)^2 / σ_i^2))
        // log p(x) = -0.5 * d * log(2π) - 0.5 * Σ_i log σ_i^2 - 0.5 * Σ_i ((x_i-μ_i)^2 / σ_i^2)
        const logDetSigma = sigmaSq.reduce((acc, v) => acc + log(v), 0);
        const quadForm = row.reduce((acc, val, i) => {
            const diff = val - mu[i];
            return acc + (diff * diff) / sigmaSq[i];
        }, 0);
        const logProb = -0.5 * dim * log(2 * Math.PI) - 0.5 * logDetSigma - 0.5 * quadForm;
        return -logProb; // higher score = lower probability = more anomalous
    });

    return scores;
}

// Core Pipeline Class
class AnalyticsPipeline {
    private serviceUrls: Record<string, string>;

    constructor(serviceUrls: Record<string, string>) {
        this.serviceUrls = serviceUrls;
    }

    /**
     * Execute the full pipeline: fetch, reduce, cluster, score, rank.
     * @returns Ranked list of processed events.
     */
    async run(): Promise<ProcessedEvent[]> {
        // 1. Ingest events
        const [incidentEvents, managementEvents, dashboardEvents] = await Promise.all([
            fetchEventsFromService(this.serviceUrls.incident, 'incident'),
            fetchEventsFromService(this.serviceUrls.management, 'management'),
            fetchEventsFromService(this.serviceUrls.dashboard, 'dashboard')
        ]);

        const allEvents = [...incidentEvents, ...managementEvents, ...dashboardEvents];
        if (allEvents.length === 0) {
            return [];
        }

        // 2. Extract feature matrix
        const featureMatrix = allEvents.map(ev => ev.features);

        // 3. PCA dimensionality reduction
        const pcaComponents = applyPCA(featureMatrix);

        // 4. DBSCAN clustering
        const clusterLabels = applyDBSCAN(pcaComponents, 0.5, 5);

        // 5. Bayesian anomaly scores
        const bayesianScores = computeBayesianScores(pcaComponents);

        // 6. Assemble processed events
        const processed: ProcessedEvent[] = allEvents.map((ev, idx) => ({
            ...ev,
            pcaComponents: pcaComponents[idx],
            cluster: clusterLabels[idx],
            bayesianScore: