import { promises as fs } from 'fs';
import path from 'path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import fetch from 'node-fetch';
import * as z from 'zod';
import { KMeans } from 'ml-kmeans';
import { Matrix, SingularValueDecomposition } from 'ml-matrix';

/**
 * Simple Kalman Filter implementation for 1‑D series.
 * 
 * State transition:      xₖ = A·xₖ₋₁ + wₖ,   wₖ ~ N(0, Q)
 * Observation model:     zₖ = H·xₖ + vₖ,   vₖ ~ N(0, R)
 * 
 * Predict:
 *   x̂ₖ⁻ = A·x̂ₖ₋₁
 *   Pₖ⁻ = A·Pₖ₋₁·Aᵀ + Q
 * Update:
 *   Kₖ = Pₖ⁻·Hᵀ·(H·Pₖ⁻·Hᵀ + R)⁻¹
 *   x̂ₖ = x̂ₖ⁻ + Kₖ·(zₖ - H·x̂ₖ⁻)
 *   Pₖ = (I - Kₖ·H)·Pₖ⁻
 */
class KalmanFilter1D {
  private A: number; // state transition coefficient
  private H: number; // observation coefficient
  private Q: number; // process noise covariance
  private R: number; // measurement noise covariance
  private x: number; // estimated state
  private P: number; // estimated covariance

  constructor(
    A: number,
    H: number,
    Q: number,
    R: number,
    initialState: number,
    initialCovariance: number
  ) {
    this.A = A;
    this.H = H;
    this.Q = Q;
    this.R = R;
    this.x = initialState;
    this.P = initialCovariance;
  }

  predict(): void {
    this.x = this.A * this.x;
    this.P = this.A * this.P * this.A + this.Q;
  }

  update(z: number): void {
    const S = this.H * this.P * this.H + this.R; // Innovation covariance
    const K = (this.P * this.H) / S; // Kalman gain
    const y = z - this.H * this.x; // Innovation
    this.x = this.x + K * y;
    this.P = (1 - K * this.H) * this.P;
  }

  filter(series: number[]): number[] {
    const filtered: number[] = [];
    for (const measurement of series) {
      this.predict();
      this.update(measurement);
      filtered.push(this.x);
    }
    return filtered;
  }

  getState(): number {
    return this.x;
  }

  getCovariance(): number {
    return this.P;
  }
}

/* -------------------- Input Schemas -------------------- */

const DatasetLoadConfigSchema = z.object({
  source: z.string().url().or(z.string().min(1)), // URL or local path
  format: z.enum(['csv', 'json']).default('csv')
});

const KMeansConfigSchema = z.object({
  k: z.number().int().positive(),
  maxIterations: z.number().int().positive().default(300),
  tolerance: z.number().positive().default(1e-4)
});

const KalmanConfigSchema = z.object({
  A: z.number().default(1),
  H: z.number().default(1),
  Q: z.number().nonnegative().default(1e-5),
  R: z.number().nonnegative().default(1e-2),
  initialState: z.number().default(0),
  initialCovariance: z.number().positive().default(1)
});

const S3ConfigSchema = z.object({
  bucket: z.string().min(1),
  region: z.string().min(1),
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1)
});

const RegisterConfigSchema = z.object({
  endpoint: z.string().url(),
  jwtToken: z.string().min(1)
});

/* -------------------- Core Functions -------------------- */

/**
 * Load dataset from a URL or local file.
 * Returns a 2‑D numeric array.
 */
export async function loadDataset(
  config: z.infer<typeof DatasetLoadConfigSchema>
): Promise<number[][]> {
  const parsed = DatasetLoadConfigSchema.parse(config);
  let raw: string;

  if (parsed.source.startsWith('http://') || parsed.source.startsWith('https://')) {
    const response = await fetch(parsed.source);
    if (!response.ok) {
      throw new Error(`Failed to fetch dataset: ${response.status} ${response.statusText}`);
    }
    raw = await response.text();
  } else {
    const filePath = path.resolve(parsed.source);
    raw = await fs.readFile(filePath, 'utf-8');
  }

  if (parsed.format === 'csv') {
    const rows = raw.trim().split('\n');
    return rows.map(row => {
      const cols = row.split(',').map(v => Number(v.trim()));
      if (cols.some(isNaN)) {
        throw new Error('CSV contains non‑numeric values.');
      }
      return cols;
    });
  } else {
    // JSON format expected to be an array of arrays of numbers
    const data = JSON.parse(raw);
    if (!Array.isArray(data) || !data.every(row => Array.isArray(row) && row.every(v => typeof v === 'number'))) {
      throw new Error('Invalid JSON dataset format.');
    }
    return data;
  }
}

/**
 * Run K‑Means clustering.
 * Returns centroids and assignments.
 */
export async function runKMeans(
  data: number[][],
  config: z.infer<typeof KMeansConfigSchema>
): Promise<{ centroids: number[][]; assignments: number[] }> {
  const parsed = KMeansConfigSchema.parse(config);
  if (data.length === 0) {
    throw new Error('Empty dataset provided to K‑Means.');
  }

  // ml-kmeans expects a Matrix or array of arrays
  const result = KMeans(data, parsed.k, {
    maxIterations: parsed.maxIterations,
    tolerance: parsed.tolerance
  });

  return {
    centroids: result.centroids,
    assignments: result.clusters
  };
}

/**
 * Fit a simple Kalman filter to each dimension of the data.
 * Returns filtered series per dimension.
 */
export async function fitKalmanFilter(
  data: number[][],
  config: z.infer<typeof KalmanConfigSchema>
): Promise<number[][]> {
  const parsed = KalmanConfigSchema.parse(config);
  if (data.length === 0) {
    throw new Error('Empty dataset provided to Kalman filter.');
  }

  // Transpose to get series per dimension
  const matrix = new Matrix(data);
  const transposed = matrix.transpose().to2DArray();

  const filteredPerDim: number[][] = transposed.map(series => {
    const kf = new KalmanFilter1D(
      parsed.A,
      parsed.H,
      parsed.Q,
      parsed.R,
      parsed.initialState,
      parsed.initialCovariance
    );
    return kf.filter(series);
  });

  // Transpose back to original shape
  const filteredMatrix = new Matrix(filteredPerDim).transpose();
  return filteredMatrix.to2DArray();
}

/**
 * Store model artifacts (JSON) in S3.
 * Returns the S3 object URL.
 */
export async function storeArtifacts(
  artifact: object,
  key: string,
  config: z.infer<typeof S3ConfigSchema>
): Promise<string> {
  const parsed = S3ConfigSchema.parse(config);
  const s3 = new S3Client({
    region: parsed.region,
    credentials: {
      accessKeyId: parsed.accessKeyId,
      secretAccessKey: parsed.secretAccessKey
    }