import express, { Request, Response, NextFunction, Router } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { Queue, Worker, Job, QueueEvents, JobStatus } from 'bullmq';
import IORedis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

// Environment variables (ensure they are set in production)
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000; // 1 minute
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 10; // 10 requests per window

// Initialize Redis connection
const redisConnection = new IORedis(REDIS_URL);

// Initialize BullMQ queue and events
const explainQueue = new Queue('explainQueue', { connection: redisConnection });
const queueEvents = new QueueEvents('explainQueue', { connection: redisConnection });

// Types
interface AnomalyCluster {
  id: string;
  documents: string[]; // raw text documents belonging to the cluster
}

interface ExplainJobData {
  clusters: AnomalyCluster[];
  requestId: string;
}

// Middleware: JWT validation
function authenticateJwt(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
    // Attach payload to request for downstream use if needed
    (req as any).user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid JWT token' });
  }
}

// Middleware: Rate limiting
const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// Helper: Compute TF‑IDF for terms across all clusters
function computeTfIdf(clusters: AnomalyCluster[]): Map<string, number> {
  const termDocCount = new Map<string, number>();
  const totalDocs = clusters.reduce((sum, c) => sum + c.documents.length, 0);

  // Document frequency (DF)
  for (const cluster of clusters) {
    const seenInDoc = new Set<string>();
    for (const doc of cluster.documents) {
      const terms = doc.toLowerCase().match(/\b\w+\b/g) || [];
      for (const term of terms) {
        if (!seenInDoc.has(term)) {
          termDocCount.set(term, (termDocCount.get(term) ?? 0) + 1);
          seenInDoc.add(term);
        }
      }
    }
  }

  // TF‑IDF calculation
  const tfIdf = new Map<string, number>();
  for (const cluster of clusters) {
    for (const doc of cluster.documents) {
      const terms = doc.toLowerCase().match(/\b\w+\b/g) || [];
      const termFreq = new Map<string, number>();
      for (const term of terms) {
        termFreq.set(term, (termFreq.get(term) ?? 0) + 1);
      }
      const maxFreq = Math.max(...Array.from(termFreq.values()));
      for (const [term, freq] of termFreq.entries()) {
        const tf = 0.5 + 0.5 * (freq / maxFreq); // normalized term frequency
        const df = termDocCount.get(term) ?? 1;
        const idf = Math.log((totalDocs + 1) / (df + 1)) + 1; // smoothed IDF
        const score = tf * idf;
        tfIdf.set(term, (tfIdf.get(term) ?? 0) + score);
      }
    }
  }
  return tfIdf;
}

// Helper: Compute Bayesian posterior scores for each cluster
function computePosteriorScores(clusters: AnomalyCluster[]): Record<string, number> {
  // Prior using TF‑IDF sum per cluster
  const tfIdf = computeTfIdf(clusters);
  const clusterPriors: Record<string, number> = {};

  for (const cluster of clusters) {
    let prior = 0;
    for (const doc of cluster.documents) {
      const terms = doc.toLowerCase().match(/\b\w+\b/g) || [];
      for (const term of terms) {
        prior += tfIdf.get(term) ?? 0;
      }
    }
    clusterPriors[cluster.id] = prior;
  }

  // Likelihood placeholder: assume uniform likelihood (1) for simplicity
  // Posterior ∝ Likelihood × Prior
  const unnormalizedPosteriors = Object.entries(clusterPriors).map(
    ([id, prior]) => ({ id, value: prior })
  );

  // Normalization constant (Σ prior)
  const sumPrior = unnormalizedPosteriors.reduce((acc, cur) => acc + cur.value, 0) || 1;

  // Posterior probabilities
  const posteriorScores: Record<string, number> = {};
  for (const { id, value } of unnormalizedPosteriors) {
    posteriorScores[id] = value / sumPrior; // Equation: P(C_i|D) = (P(D|C_i)·P(C_i)) / Σ_j P(D|C_j)·P(C_j)
  }

  return posteriorScores;
}

// Worker: processes explain jobs
const explainWorker = new Worker<ExplainJobData>(
  'explainQueue',
  async (job: Job<ExplainJobData>) => {
    const { clusters, requestId } = job.data;
    if (!Array.isArray(clusters) || clusters.length === 0) {
      throw new Error('Invalid clusters payload');
    }
    // Compute posterior scores
    const scores = computePosteriorScores(clusters);
    // Store result in Redis for quick retrieval by status endpoint
    const resultKey = `