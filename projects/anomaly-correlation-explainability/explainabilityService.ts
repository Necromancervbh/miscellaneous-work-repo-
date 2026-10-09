import express, { Request, Response, NextFunction } from 'express';
import LRUCache from 'lru-cache';
import { beta } from 'jstat';

// Types
interface AnomalyData {
  successes: number; // number of observed normal events
  failures: number; // number of observed anomalous events
}

interface PosteriorResult {
  alpha: number;
  beta: number;
  mean: number;
  credibleInterval: {
    lower: number;
    upper: number;
  };
}

interface Explanation {
  anomalyId: string;
  posterior: PosteriorResult;
}

// Configuration
const PRIOR_ALPHA = 1; // Uniform prior
const PRIOR_BETA = 1;
const CREDIBLE_LEVEL = 0.95; // 95% credible interval
const CACHE_MAX_ITEMS = 500;
const CACHE_MAX_AGE_MS = 1000 * 60 * 60; // 1 hour

// LRU Cache for explanations
const explanationCache = new LRUCache<string, Explanation>({
  max: CACHE_MAX_ITEMS,
  ttl: CACHE_MAX_AGE_MS,
});

// Mock data retrieval – replace with real DB/service call
async function getAnomalyData(anomalyId: string): Promise<AnomalyData> {
  // Simulate async I/O latency
  await new Promise((resolve) => setTimeout(resolve, 10));

  // For demonstration, generate pseudo‑random counts based on the ID hash
  const hash = anomalyId
    .split('')
    .reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const successes = (hash * 7) % 100 + 1;
  const failures = (hash * 13) % 100 + 1;
  return { successes, failures };
}

/**
 * Compute Bayesian posterior for a Beta‑Bernoulli model.
 *
 * Prior: Beta(α₀, β₀)
 * Likelihood: successes ~ Binomial(n, θ)
 * Posterior: Beta(α₀ + successes, β₀ + failures)
 *
 * @param priorAlpha α₀
 * @param priorBeta β₀
 * @param successes number of observed successes
 * @param failures number of observed failures
 * @returns Posterior parameters, mean, and credible interval
 */
function computePosterior(
  priorAlpha: number,
  priorBeta: number,
  successes: number,
  failures: number
): PosteriorResult {
  const alphaPost = priorAlpha + successes;
  const betaPost = priorBeta + failures;

  // Posterior mean: E[θ] = α / (α + β)
  const mean = alphaPost / (alphaPost + betaPost);

  // Credible interval using Beta quantiles
  const lowerQuantile = (1 - CREDIBLE_LEVEL) / 2;
  const upperQuantile = 1 - lowerQuantile;

  const lower = beta.inv(lowerQuantile, alphaPost, betaPost);
  const upper = beta.inv(upperQuantile, alphaPost, betaPost);

  return {
    alpha: alphaPost,
    beta: betaPost,
    mean,
    credibleInterval: {
      lower,
      upper,
    },
  };
}

// Middleware for async error handling
function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

// Express router
const router = express.Router();

/**
 * POST /explain
 * Body: { anomalyIds: string[] }
 * Returns: { explanations: Explanation[] }
 */
router.post(
  '/explain',
  asyncHandler(async (req: Request, res: Response) => {
    const { anomalyIds } = req.body;

    // Input validation
    if (!Array.isArray(anomalyIds) || anomalyIds.length === 0) {
      return res.status(400).json({ error: 'anomalyIds must be a non‑empty array.' });
    }
    if (!anomalyIds.every((id) => typeof id === 'string' && id.trim().length > 0)) {
      return res
        .status(400)
        .json({ error: 'Each anomalyId must be a non‑empty string.' });
    }

    const explanations: Explanation[] = [];

    for (const anomalyId of anomalyIds) {
      // Check cache first
      const cached = explanationCache.get(anomalyId);
      if (cached) {
        explanations.push(cached);
        continue;
      }

      // Retrieve data
      let data: AnomalyData;
      try {
        data = await getAnomalyData(anomalyId);
      } catch (err) {
        // If data retrieval fails, skip this ID but log the error
        console.error(`Failed to retrieve data for anomalyId ${anomalyId}:`, err);
        continue;
      }

      // Compute posterior
      const posterior = computePosterior(
        PRIOR_ALPHA,
        PRIOR_BETA,
        data.successes,
        data.failures
      );

      const explanation: Explanation = {
        anomalyId,
        posterior,
      };

      // Cache result
      explanationCache.set(anomalyId, explanation);
      explanations.push(explanation);
    }

    return res.json({ explanations });
  })
);

// Global error handler
router.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

export default router;