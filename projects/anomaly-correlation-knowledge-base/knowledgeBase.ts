import express, { Request, Response, NextFunction } from 'express';
import { graphqlHTTP } from 'express-graphql';
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  GraphQLFloat,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLID,
} from 'graphql';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import LRUCache from 'lru-cache';
import fetch from 'node-fetch';
import kmeans from 'ml-kmeans';

// ---------- Configuration ----------
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey';
const GRAPH_API_URL = process.env.GRAPH_API_URL || 'http://localhost:5000/graph';
const PREDICTION_ENGINE_URL =
  process.env.PREDICTION_ENGINE_URL || 'http://localhost:5001/predict';
const DASHBOARD_API_URL =
  process.env.DASHBOARD_API_URL || 'http://localhost:5002/dashboard';

// ---------- LRU Cache ----------
type CacheValue = {
  anomalyScores: CompositeAnomalyScore[];
  timestamp: number;
};
const cache = new LRUCache<string, CacheValue>({
  max: 500, // max 500 entries
  ttl: 1000 * 60 * 5, // 5 minutes TTL
});

// ---------- Types ----------
interface SourceScore {
  source: string;
  score: number; // probability in [0,1]
}

interface CompositeAnomalyScore extends SourceScore {
  compositeScore: number; // Bayesian posterior
  cluster: number; // K‑Means cluster index
}

// ---------- JWT Authentication Middleware ----------
function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Malformed Authorization header' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Attach payload to request for downstream use if needed
    (req as any).user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ---------- Rate Limiting ----------
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120, // limit each IP to 120 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// ---------- Helper Functions ----------
async function fetchJSON(url: string, params: Record<string, any> = {}): Promise<any> {
  const query = new URLSearchParams(params).toString();
  const fullUrl = query ? `${url}?${query}` : url;
  const response = await fetch(fullUrl, { timeout: 5000 });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to fetch ${fullUrl}: ${response.status} ${text}`);
  }
  return response.json();
}

// Fetch data from the three external services
async function fetchGraphData(entityId: string): Promise<SourceScore[]> {
  const data = await fetchJSON(GRAPH_API_URL, { entityId });
  // Expecting: { anomalies: [{ source: string, probability: number }, ...] }
  if (!Array.isArray(data.anomalies)) {
    throw new Error('Invalid response format from Graph API');
  }
  return data.anomalies.map((a: any) => ({
    source: a.source ?? 'graph',
    score: Number(a.probability),
  }));
}

async function fetchPredictionData(entityId: string): Promise<SourceScore[]> {
  const data = await fetchJSON(PREDICTION_ENGINE_URL, { entityId });
  // Expecting: { predictions: [{ model: string, prob: number }, ...] }
  if (!Array.isArray(data.predictions)) {
    throw new Error('Invalid response format from Prediction Engine');
  }
  return data.predictions.map((p: any) => ({
    source: p.model ?? 'prediction',
    score: Number(p.prob),
  }));
}

async function fetchDashboardData(entityId: string): Promise<SourceScore[]> {
  const data = await fetchJSON(DASHBOARD_API_URL, { entityId });
  // Expecting: { metrics: [{ name: string, anomalyScore: number }, ...] }
  if (!Array.isArray(data.metrics)) {
    throw new Error('Invalid response format from Dashboard API');
  }
  return data.metrics.map((m: any) => ({
    source: m.name ?? 'dashboard',
    score: Number(m.anomalyScore),
  }));
}

// ---------- Bayesian Inference ----------
/**
 * Compute posterior probability using naive Bayes.
 * Prior is assumed uniform (1 / N_sources).
 * Posterior ∝ prior * Π likelihood_i
 * Then normalized to [0,1].
 */
function computeBayesianPosterior(scores: number[]): number {
  if (scores.length === 0) return 0;
  const prior = 1 / scores.length;
  const product = scores.reduce((acc, s) => acc * s, 1);
  const unnormalized = prior * product;
  // Normalization across all possible outcomes is not required for ranking,
  // but we map to [0,1] by dividing by max possible (which is prior * 1^n = prior)
  const posterior = unnormalized / prior; // simplifies to product
  // Ensure within [0,1]
  return Math.min(Math.max(posterior, 0), 1);
}

// ---------- K‑Means Clustering ----------
/**
 * Perform K‑Means clustering on composite scores.
 * Returns an array of cluster indices aligned with input scores.
 *
 * Formula: minimize Σ ||x_i - μ_{c(i)}||^2
 */
function clusterScores(
  compositeScores: number[],
  k: number = 3,
): number[] {
  if (compositeScores.length === 0) return [];
  // ml-kmeans expects data as array of arrays
  const data = compositeScores.map((v) => [v]);
  const result = kmeans(data, k);
  // result.clusters is an array of cluster indices per point
  return result.clusters;
}

// ---------- Resolver Logic ----------
async function getCompositeAnomalyScores(entityId: string): Promise<CompositeAnomalyScore[]> {
  // Check