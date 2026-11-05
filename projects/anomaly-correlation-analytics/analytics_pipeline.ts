import { createReadStream, promises as fsPromises } from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { spawn } from 'child_process';
import Redis from 'ioredis';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

/**
 * Types
 */
interface TimeSeriesPoint {
    timestamp: string; // ISO string
    values: number[];
}

interface AnalyticsResult {
    pcaComponents: number[][]; // shape: [nSamples, nComponents]
    dbscanLabels: number[]; // length: nSamples
    anomalyScores: number[]; // length: nSamples
}

/**
 * Utility functions
 */

/**
 * Validates that the provided path points to an existing readable file.
 * @param filePath Absolute or relative path to the file.
 * @throws Error if the file does not exist or is not readable.
 */
async function validateFilePath(filePath: string): Promise<void> {
    try {
        const stats = await fsPromises.stat(filePath);
        if (!stats.isFile()) {
            throw new Error(`Path ${filePath} is not a file.`);
        }
    } catch (err) {
        throw new Error(`Cannot access file ${filePath}: ${(err as Error).message}`);
    }
}

/**
 * Parses a CSV file where the first column is a timestamp and the remaining columns are numeric values.
 * Returns an array of TimeSeriesPoint.
 * @param csvPath Path to the CSV file.
 */
async function loadCsvTimeSeries(csvPath: string): Promise<TimeSeriesPoint[]> {
    await validateFilePath(csvPath);
    const points: TimeSeriesPoint[] = [];

    const rl = readline.createInterface({
        input: createReadStream(csvPath),
        crlfDelay: Infinity,
    });

    for await (const line of rl) {
        if (!line.trim()) continue; // skip empty lines
        const parts = line.split(',').map(p => p.trim());
        if (parts.length < 2) {
            throw new Error(`Invalid CSV line (needs at least timestamp + one value): ${line}`);
        }
        const timestamp = parts[0];
        const values = parts.slice(1).map(v => {
            const num = Number(v);
            if (Number.isNaN(num)) {
                throw new Error(`Non-numeric value encountered in line: ${line}`);
            }
            return num;
        });
        points.push({ timestamp, values });
    }

    if (points.length === 0) {
        throw new Error(`CSV file ${csvPath} contains no data.`);
    }

    return points;
}

/**
 * Serializes the time‑series data to a 2‑D numeric array suitable for PCA/DBSCAN.
 * @param points Array of TimeSeriesPoint.
 */
function extractNumericMatrix(points: TimeSeriesPoint[]): number[][] {
    return points.map(p => p.values);
}

/**
 * Executes the Python analytics script.
 * The script receives a JSON payload via stdin and returns a JSON payload via stdout.
 * @param matrix 2‑D numeric array (nSamples × nFeatures).
 */
function runPythonAnalytics(matrix: number[][]): Promise<AnalyticsResult> {
    return new Promise<AnalyticsResult>((resolve, reject) => {
        // Python script source (embedded)
        const pythonScript = `
import sys, json, numpy as np
from sklearn.decomposition import PCA
from sklearn.cluster import DBSCAN
from scipy.stats import norm

def bayesian_anomaly_score(residuals):
    # Assume residuals follow a normal distribution N(mu, sigma^2)
    mu, sigma = np.mean(residuals), np.std(residuals)
    # Compute two‑sided p‑value for each residual
    p_vals = 2 * (1 - norm.cdf(np.abs(residuals - mu) / sigma))
    # Convert p‑values to scores (higher = more anomalous)
    scores = -np.log10(p_vals + 1e-12)
    return scores.tolist()

def main():
    try:
        payload = json.load(sys.stdin)
        data = np.array(payload["matrix"])
        # ---------- PCA ----------
        # Retain 95% variance (formula: cumulative explained variance >= 0.95)
        pca = PCA(n_components=0.95, svd_solver='full')
        pca_components = pca.fit_transform(data)
        # ---------- DBSCAN ----------
        # eps and min_samples are heuristically chosen; can be tuned.
        dbscan = DBSCAN(eps=0.5, min_samples=5)
        labels = dbscan.fit_predict(pca_components)
        # ---------- Bayesian Anomaly ----------
        # Compute reconstruction error as residuals
        reconstructed = pca.inverse_transform(pca_components)
        residuals = np.linalg.norm(data - reconstructed, axis=1)
        anomaly_scores = bayesian_anomaly_score(residuals)

        result = {
            "pcaComponents": pca_components.tolist(),
            "dbscanLabels": labels.tolist(),
            "anomalyScores": anomaly_scores
        }
        json.dump(result, sys.stdout)
    except Exception as e:
        sys.stderr.write(str(e))
        sys.exit(1)

if __name__ == "__main__":
    main()
`;

        // Write script to a temporary file
        const scriptPath = path.join(tmpdir(), `analytics_${randomUUID()}.py`);
        fsPromises.writeFile(scriptPath, pythonScript, { mode: 0o700 })
            .then(() => {
                const python = spawn('python3', [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });

                let stdout = '';
                let stderr = '';

                python.stdout.on('data', data => { stdout += data.toString(); });
                python.stderr.on('data', data => { stderr += data.toString(); });

                python.on('error', err => {
                    reject(new Error(`Failed to start Python process: ${err.message}`));
                });

                python.on('close', code => {
                    // Clean up temporary script file
                    fsPromises.unlink(scriptPath).catch(() => { /* ignore */ });

                    if (code !== 0) {
                        reject(new Error(`Python script exited with code ${code}: ${stderr}`));
                        return;
                    }
                    try {
                        const result: AnalyticsResult = JSON.parse(stdout);
                        resolve(result);
                    } catch (parseErr) {
                        reject(new Error(`Failed to parse Python output: ${(parseErr as Error).message}`));
                    }
                });

                // Send input JSON
                const inputPayload = JSON.stringify({ matrix });
                python.stdin.write(inputPayload);
                python.stdin.end();
            })
            .catch(err => {
                reject(new Error(`Failed to write temporary Python script: ${(err as Error).message}`));
            });
    });
}

/**
 * Stores a summary object in Redis as a JSON string.
 * @param redis Redis client instance.
 * @param key Cache key.
 * @param summary Arbitrary object to be cached.
 * @param ttlSeconds Time‑to‑live in seconds (optional, default 3600).
 */
async function storeSummaryInRedis(redis: Redis.Redis, key: string, summary: any, ttlSeconds: number = 3600): Promise<void> {
    if (typeof key !== 'string' || !key) {
        throw new Error('Invalid Redis key.');
    }
    const payload = JSON.stringify(summary);
    await redis.set(key, payload, 'EX', ttlSeconds);
}

/**
 * Main service class
 */
export class AnalyticsPipeline {
    private redisClient: Redis.Redis;

    /**
     * @param redisOptions Options for ioredis client.
     */
    constructor(redisOptions?: Redis.RedisOptions) {
        this.redisClient = new Redis(redisOptions);
        this.redisClient