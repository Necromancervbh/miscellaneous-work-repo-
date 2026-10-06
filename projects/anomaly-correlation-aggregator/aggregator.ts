import express, { Request, Response, NextFunction } from 'express';
import { createServer } from 'http';
import fetch, { Response as FetchResponse } from 'node-fetch';
import { Readable } from 'stream';
import jwt from 'jsonwebtoken';
import LRUCache from 'lru-cache';
import { Matrix, SingularValueDecomposition } from 'ml-matrix';
import { URL } from 'url';
import { EventEmitter } from 'events';
import { promisify } from 'util';
import { pipeline } from 'stream';
import { createHash } from 'crypto';

// ---------- Configuration ----------
interface AggregatorConfig {
    forecastApiUrl: string;          // URL of the forecasting API stream
    orchestratorApiUrl: string;      // URL of the orchestrator API stream
    jwtSecret: string;               // Secret for JWT verification
    cacheMaxSize: number;            // Max number of entries in LRU cache
    cacheTTLms: number;              // Time‑to‑live for cache entries
    port: number;                    // Port for the HTTP server
    weightForecast: number;          // Weight for forecast data in PCA
    weightOrchestrator: number;      // Weight for orchestrator data in PCA
    pcaComponents: number;           // Number of principal components to retain
}

// Load configuration from environment variables with validation
function loadConfig(): AggregatorConfig {
    const requiredEnv = [
        'FORECAST_API_URL',
        'ORCHESTRATOR_API_URL',
        'JWT_SECRET',
        'PORT'
    ] as const;

    for (const key of requiredEnv) {
        if (!process.env[key]) {
            throw new Error(`Missing required environment variable: ${key}`);
        }
    }

    const weightForecast = Number(process.env.WEIGHT_FORECAST ?? '0.5');
    const weightOrchestrator = Number(process.env.WEIGHT_ORCHESTRATOR ?? '0.5');
    const pcaComponents = Number(process.env.PCA_COMPONENTS ?? '1');

    if (isNaN(weightForecast) || weightForecast <= 0) {
        throw new Error('WEIGHT_FORECAST must be a positive number');
    }
    if (isNaN(weightOrchestrator) || weightOrchestrator <= 0) {
        throw new Error('WEIGHT_ORCHESTRATOR must be a positive number');
    }
    if (isNaN(pcaComponents) || pcaComponents < 1) {
        throw new Error('PCA_COMPONENTS must be a positive integer');
    }

    return {
        forecastApiUrl: process.env.FORECAST_API_URL!,
        orchestratorApiUrl: process.env.ORCHESTRATOR_API_URL!,
        jwtSecret: process.env.JWT_SECRET!,
        cacheMaxSize: Number(process.env.CACHE_MAX_SIZE ?? '500'),
        cacheTTLms: Number(process.env.CACHE_TTL_MS ?? `${5 * 60 * 1000}`), // default 5 minutes
        port: Number(process.env.PORT!),
        weightForecast,
        weightOrchestrator,
        pcaComponents,
    };
}

// ---------- JWT Middleware ----------
function jwtAuthMiddleware(secret: string) {
    return (req: Request, res: Response, next: NextFunction) => {
        const authHeader = req.headers['authorization'];
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Missing or malformed Authorization header' });
        }
        const token = authHeader.slice(7);
        jwt.verify(token, secret, (err, decoded) => {
            if (err) {
                return res.status(401).json({ error: 'Invalid token' });
            }
            // Attach decoded payload to request for downstream use if needed
            (req as any).user = decoded;
            next();
        });
    };
}

// ---------- Utility Functions ----------
/**
 * Reads a JSON‑lines (NDJSON) stream and returns an array of parsed objects.
 * Each line must be a valid JSON array of numbers (e.g., "[1,2,3]").
 */
async function readJsonLines(stream: Readable): Promise<number[][]> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const data = Buffer.concat(chunks).toString('utf8');
    const lines = data.split('\n').filter(l => l.trim().length > 0);
    const result: number[][] = [];
    for (const line of lines) {
        try {
            const parsed = JSON.parse(line);
            if (!Array.isArray(parsed) || !parsed.every(v => typeof v === 'number')) {
                throw new Error('Invalid line format');
            }
            result.push(parsed);
        } catch (e) {
            // Skip malformed lines but log for debugging
            console.warn(`Skipping malformed line: ${line}`);
        }
    }
    return result;
}

/**
 * Consumes a streaming endpoint that returns NDJSON.
 * Returns a promise that resolves to a matrix (array of rows).
 */
async function fetchStreamData(url: string): Promise<number[][]> {
    let response: FetchResponse;
    try {
        response = await fetch(url);
    } catch (err) {
        throw new Error(`Failed to fetch ${url}: ${(err as Error).message}`);
    }
    if (!response.ok || !response.body) {
        throw new Error(`Unexpected response from ${url}: ${response.status} ${response.statusText}`);
    }
    return await readJsonLines(response.body as unknown as Readable);
}

/**
 * Generates a deterministic cache key based on input matrices and weights.
 */
function generateCacheKey(
    forecast: number[][],
    orchestrator: number[][],
    weightForecast: number,
    weightOrchestrator: number
): string {
    const hash = createHash('sha256');
    hash.update(JSON.stringify({ forecast, orchestrator, weightForecast, weightOrchestrator }));
    return hash.digest('hex');
}

/**
 * Performs weighted PCA on two data sources.
 *
 * Let A ∈ ℝ^{n×p} be forecast data, B ∈ ℝ^{n×q} be orchestrator data.
 * Apply weights w₁, w₂ by scaling rows:
 *   A' = √w₁ * A
 *