import express, { Request, Response, NextFunction } from 'express';
import bodyParser from 'body-parser';
import jwt from 'jsonwebtoken';
import { expressjwt, GetVerificationKey } from 'express-jwt';
import rateLimit from 'express-rate-limit';
import { Queue, Worker, QueueScheduler, Job } from 'bullmq';
import { PCA } from 'ml-pca';
import { create, all, Matrix, type MathJsStatic } from 'mathjs';
import { randomUUID } from 'crypto';
import dotenv from 'dotenv';
import { createServer } from 'http';

// Load environment variables
dotenv.config();

const math = create(all, {}) as MathJsStatic;

// ---------------------------
// Configuration & Constants
// ---------------------------
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 100; // max requests per window per IP
const PCA_VARIANCE_RATIO = 0.95; // retain 95% variance

// ---------------------------
// Types
// ---------------------------
interface InsightPayload {
  // Array of observations, each observation is an array of numeric features
  observations: number[][];
}

interface AnomalyResult {
  id: string;
  timestamp: string;
  anomalyScore: number;
  smoothed: number[][];
  reduced: number[][];
}

// ---------------------------
// JWT Middleware
// ---------------------------
const getKey: GetVerificationKey = (req, header, callback) => {
  callback(null, JWT_SECRET);
};

const jwtMiddleware = expressjwt({
  secret: getKey,
  algorithms: ['HS256'],
});

// ---------------------------
// Rate Limiting Middleware
// ---------------------------
const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'Too many requests, please try again later.' });
  },
});

// ---------------------------
// Kalman Filter Implementation
// ---------------------------
class KalmanFilter {
  // State vector (x) and covariance matrix (P)
  private x: Matrix;
  private P: Matrix;
  private Q: Matrix; // Process noise covariance
  private R: Matrix; // Measurement noise covariance
  private H: Matrix; // Observation matrix
  private I: Matrix; // Identity matrix

  /**
   * Initialize Kalman filter for a d‑dimensional system.
   * @param dim Dimensionality of the state vector.
   * @param processNoise Variance of process noise (scalar or array of length dim).
   * @param measurementNoise Variance of measurement noise (scalar or array of length dim).
   */
  constructor(
    dim: number,
    processNoise: number | number[] = 1e-5,
    measurementNoise: number | number[] = 1e-2,
  ) {
    this.x = math.zeros(dim) as Matrix;
    this.P = math.identity(dim) as Matrix;
    this.Q = typeof processNoise === 'number'
      ? math.multiply(math.identity(dim), processNoise) as Matrix
      : math.diag(processNoise) as Matrix;
    this.R = typeof measurementNoise === 'number'
      ? math.multiply(math.identity(dim), measurementNoise) as Matrix
      : math.diag(measurementNoise) as Matrix;
    this.H = math.identity(dim) as Matrix;
    this.I = math.identity(dim) as Matrix;
  }

  /**
   * Perform a single predict‑update cycle with a new measurement.
   * @param z Measurement vector (1‑D array of length dim).
   * @returns Updated state estimate.
   */
  public filter(z: number[]): number[] {
    // Predict step (state transition is identity)
    const xPred = this.x;
    const PPred = math.add(this.P, this.Q) as Matrix;

    // Update step
    const y = math.subtract(z, math.multiply(this.H, xPred)) as Matrix; // Innovation
    const S = math.add(math.multiply(math.multiply(this.H, PPred), math.transpose(this.H)), this.R) as Matrix;
    const K = math.multiply(math.multiply(PPred, math.transpose(this.H)), math.inv(S)) as Matrix; // Kalman gain

    this.x = math.add(xPred, math.multiply(K, y)) as Matrix;
    const KH = math.multiply(K, this.H) as Matrix;
    this.P = math.multiply(math.subtract(this.I, KH), PPred) as Matrix;

    return (this.x as any).toArray() as number[];
  }
}

/**
 * Apply Kalman smoothing to a sequence of observations.
 * @param data Matrix of shape (nSamples, nFeatures)
 * @returns Smoothed data matrix of same shape.
 */
function applyKalmanFilter(data: number[][]): number[][] {
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('Kalman filter input must be a non‑empty array of observations.');
  }
  const dim = data[0].length;
  const kf = new KalmanFilter(dim);
  const smoothed: number[][] = [];
  for (const obs of data) {
    if (!Array.isArray(obs) || obs.length !== dim) {
      throw new Error('All observations must have the same dimensionality.');
    }
    smoothed.push(kf.filter(obs));
  }
  return smoothed;
}

// ---------------------------
// PCA Reduction
// ---------------------------
/**
 * Reduce dimensionality using PCA while retaining a target variance ratio.
 * @param data Input matrix (nSamples x nFeatures)
 * @returns Object containing reduced data and the PCA model.
 */
function applyPCA(data: number[][]): { reduced: number[][]; model: PCA } {
  const pca = new PCA(data, { center: true, scale: true });
  const cumulativeVariance = pca.getCumulativeVariance();
  let nComponents = cumulativeVariance.findIndex(v => v >= PCA_VARIANCE_RATIO * 100) + 1;
  if (nComponents === 0) nComponents = cumulativeVariance.length; // fallback
  const reduced = pca.predict(data, { nComponents }) as number[][];
  return { reduced, model: pca };
}

/**
 * Reconstruct original data from reduced representation.
 * @param reduced Reduced matrix.
 * @param model Trained PCA model.
 * @returns Reconstructed data matrix.
 */
function reconstructFromPCA(reduced: number[][], model: PCA): number[][] {
  return model.inverseTransform(reduced) as number[][];
}

// ---------------------------
// Anomaly Scoring
// ---------------------------
/**
 * Compute anomaly score as Euclidean reconstruction error.
 * @param original Original data