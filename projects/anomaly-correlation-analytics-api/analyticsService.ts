import express, { Request, Response, NextFunction, Router } from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import LRUCache from 'lru-cache';
import { STL } from 'stl-decomp';
import { Beta } from 'jstat';

// ---------- Configuration ----------
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const JWT_ALGORITHM: jwt.Algorithm = 'HS256';
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 100; // max requests per window per IP
const CACHE_MAX_ITEMS = 500;
const CACHE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

// ---------- Types ----------
interface Anomaly {
  timestamp: number; // epoch ms
  value: number;
}

interface STLResult {
  trend: number[];
  seasonal: number[];
  residual: number[];
}

interface BayesianConfidence {
  alpha: number;
  beta: number;
  mean: number; // posterior mean
  variance: number; // posterior variance
}

interface AggregatedResponse {
  stl: STLResult;
  confidence: BayesianConfidence;
}

// ---------- Middleware ----------
function jwtAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }
  const token = authHeader.slice(7);
  jwt.verify(token, JWT_SECRET, { algorithms: [JWT_ALGORITHM] }, (err, decoded) => {
    if (err) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }
    // Attach decoded payload to request for downstream use if needed
    (req as any).user = decoded;
    next();
  });
}

// ---------- Rate Limiter ----------
const apiLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: 'Too many requests, please try again later.' });
  },
});

// ---------- LRU Cache ----------
const cache = new LRUCache<string, AggregatedResponse>({
  max: CACHE_MAX_ITEMS,
  ttl: CACHE_MAX_AGE_MS,
});

// ---------- Helper Functions ----------
/**
 * Validates and parses start/end query parameters.
 * @throws Error if validation fails.
 */
function parseTimeRange(req: Request): { start: number; end: number } {
  const startStr = req.query.start as string | undefined;
  const endStr = req.query.end as string | undefined;
  if (!startStr || !endStr) {
    throw new Error('Missing required query parameters: start, end');
  }
  const start = Number(startStr);
  const end = Number(endStr);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error('Invalid time range: ensure start < end and both are numbers');
  }
  return { start, end };
}

/**
 * Mock function to fetch real‑time anomalies.
 * Replace with actual DB / service call.
 */
async function fetchRealTimeAnomalies(start: number, end: number): Promise<Anomaly[]> {
  // For demonstration, generate synthetic anomalies.
  const count = Math.max(1, Math.floor((end - start) / (60 * 1000))); // approx one per minute
  const anomalies: Anomaly[] = [];
  for (let i = 0; i < count; i++) {
    const timestamp = start + i * 60 * 1000 + Math.floor(Math.random() * 5000);
    const value = Math.random() * 100;
    anomalies.push({ timestamp, value });
  }
  return anomalies;
}

/**
 * Aggregates anomalies into a time‑ordered numeric series.
 * Missing minutes are filled with zeros (neutral value).
 */
function aggregateAnomalies(anomalies: Anomaly[], start: number, end: number): number[] {
  const interval = 60 * 1000; // 1‑minute bins
  const bins = Math.ceil((end - start) / interval);
  const series = new Array<number>(bins).fill(0);
  for (const a of anomalies) {
    const idx = Math.floor((a.timestamp - start) / interval);
    if (idx >= 0 && idx < bins) {
      series[idx] += a.value;
    }
  }
  return series;
}

/**
 * Performs STL decomposition.
 * Returns trend, seasonal, and residual components.
 * Formula: y_t = Trend_t + Seasonal_t + Residual_t
 */
function performSTL(series: number[]): STLResult {
  // STL parameters: period = 1440 (daily seasonality for minute data), robust = true
  const period = 1440;
  const stl = new STL(series, { period, robust: true });
  const { trend, seasonal, remainder } = stl.decompose();
  return {
    trend,
    seasonal,
    residual: remainder,
  };
}

/**
 * Computes Bayesian confidence using a Beta posterior.
 * Prior: Beta(alpha0, beta0)
 * Likelihood: successes = number of anomalies above threshold, failures = total - successes
 * Posterior: Beta(alpha0 + successes, beta0 + failures)
 */
function computeBayesianConfidence(
  anomalies: Anomaly[],
  threshold: number = 50,
  priorAlpha = 1,
  priorBeta = 1
): BayesianConfidence {
  const successes = anomalies.filter((a) => a.value > threshold).length;
  const failures = anomalies.length - successes;
  const alphaPost = priorAlpha + successes;
  const betaPost = priorBeta + failures;
  const mean = alphaPost / (alphaPost + betaPost);
  const variance = (alphaPost * betaPost) / ((alphaPost + betaPost) ** 2 * (alphaPost + betaPost + 1));
  return {
    alpha: alphaPost,
    beta: betaPost,
    mean,
    variance,
  };
}

/**
 * Generates a cache key based on request parameters.
 */
function cacheKey(start: number, end: number): string {
  return `stl:${start}-${end}`;
}

// ---------- Router ----------
const router: Router = express.Router();

router.use(express.json());
router.use(apiLimiter);
router.use(jwtAuth);

/**
 * GET /aggregated-anomalies?start=...&end=...
 * Returns STL decomposition and Bayesian confidence scores.
 */
router.get('/aggregated-anomalies', async (req: Request, res: Response) => {
  try {
    const { start, end } = parseTimeRange(req);
    const key = cacheKey(start, end);
    const cached = cache.get(key);
    if (cached) {
      res.json({ cached: true, data: cached });
      return;
    }

    const anomalies = await fetchRealTimeAnomalies(start, end);
    if (anomalies.length === 0) {
      res.status(404).json({ error: 'No anomalies found for the given time range' });
      return;
    }

    const series = aggregateAnomalies(anomalies, start, end);
    const stlResult = performSTL(series);
    const confidence = computeBayesianConfidence(anomalies);

    const response: AggregatedResponse = {
      stl: stlResult,
      confidence,
    };

    cache.set(key,