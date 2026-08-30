import express, { Request, Response, NextFunction } from 'express';
import { detectAnomalies, DetectOptions, AnomalyResult } from '../data-science/time-series/anomalyDetector';
import { body, validationResult } from 'express-validator';

/**
 * Validation middleware for the /detect-anomalies endpoint.
 * Ensures the payload contains a non‑empty numeric array and optional parameters are of correct type.
 */
const validateDetectRequest = [
  body('series')
    .isArray({ min: 1 })
    .withMessage('series must be a non‑empty array'),
  body('series.*')
    .isNumeric()
    .withMessage('each element of series must be a number'),
  body('period')
    .optional()
    .isInt({ min: 1 })
    .withMessage('period must be a positive integer'),
  body('seasonal')
    .optional()
    .isInt({ min: 1 })
    .withMessage('seasonal must be a positive integer'),
  body('robust')
    .optional()
    .isBoolean()
    .withMessage('robust must be a boolean'),
  body('threshold')
    .optional()
    .isFloat({ gt: 0 })
    .withMessage('threshold must be a positive number'),
];

/**
 * Express error‑handling wrapper for async route handlers.
 */
function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * POST /detect-anomalies
 * Body: {
 *   series: number[],                // required
 *   period?: number,                 // optional STL period (default: 7)
 *   seasonal?: number,               // optional STL seasonal component (default: 13)
 *   robust?: boolean,                // optional robust fitting flag (default: false)
 *   threshold?: number               // optional z‑score threshold for outlier flag (default: 3)
 * }
 *
 * Returns: {
 *   anomalies: number[],   // indices of detected outliers
 *   scores: number[]       // corresponding z‑scores
 * }
 */
const router = express.Router();

router.post(
  '/detect-anomalies',
  validateDetectRequest,
  asyncHandler(async (req: Request, res: Response) => {
    // ----- Input validation -----
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      series,
      period = 7,
      seasonal = 13,
      robust = false,
      threshold = 3,
    } = req.body as {
      series: number[];
      period?: number;
      seasonal?: number;
      robust?: boolean;
      threshold?: number;
    };

    // Edge‑case guards (NaN, Infinity, empty after filtering)
    const cleanedSeries = series.map((v) => Number(v)).filter((v) => Number.isFinite(v));
    if (cleanedSeries.length === 0) {
      return res.status(400).json({ error: 'Series contains no finite numeric values.' });
    }

    // Build options object respecting the DetectOptions interface of anomalyDetector
    const options: DetectOptions = {
      period,
      seasonal,
      robust,
      threshold,
    };

    // ----- Core detection -----
    let result: AnomalyResult;
    try {
      result = detectAnomalies(cleanedSeries, options);
    } catch (e) {
      // Defensive: capture any unexpected runtime errors from the detector
      const errMsg = e instanceof Error ? e.message : String(e);
      return res.status(500).json({ error: `Anomaly detection failed: ${errMsg}` });
    }

    // ----- Response -----
    return res.json({ anomalies: result.anomalyIndices, scores: result.zScores });
  })
);

/**
 * Global error handler – returns JSON with stack trace in development only.
 */
router.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const isDev = process.env.NODE_ENV !== 'production';
  const payload: any = { error: err.message || 'Internal Server Error' };
  if (isDev && err.stack) payload.stack = err.stack;
  res.status(err.status || 500).json(payload);
});

export default router;
