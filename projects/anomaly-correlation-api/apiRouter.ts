import express, { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { body, validationResult } from 'express-validator';
import { correlate, forecast } from './engine';

// ---------- Configuration ----------
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    throw new Error('Environment variable JWT_SECRET is required');
}
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const redisConnection = new IORedis(REDIS_URL);

// ---------- BullMQ Queue ----------
const jobQueue = new Queue('anomaly-jobs', {
    connection: redisConnection,
});

// ---------- Types ----------
interface AuthenticatedRequest extends Request {
    user?: { id: string };
}

// ---------- JWT Authentication Middleware ----------
function authenticateJwt(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or malformed Authorization header' });
    }
    const token = authHeader.slice(7);
    try {
        const payload = jwt.verify(token, JWT_SECRET) as { sub: string };
        req.user = { id: payload.sub };
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid token' });
    }
}

// ---------- Per‑User Rate Limiting ----------
const userRateLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute window
    max: 30, // limit each user to 30 requests per window
    keyGenerator: (req: AuthenticatedRequest) => req.user?.id || req.ip,
    handler: (req, res) => {
        res.status(429).json({ error: 'Too many requests, please try again later.' });
    },
});

// ---------- Simple 1‑D Kalman Filter ----------
/**
 * Applies a 1‑dimensional Kalman filter to a series of measurements.
 * Formula:
 *   prediction:   x̂ₖ|ₖ₋₁ = x̂ₖ₋₁|ₖ₋₁
 *   error_cov:    Pₖ|ₖ₋₁ = Pₖ₋₁|ₖ₋₁ + Q
 *   kalman_gain:  Kₖ = Pₖ|ₖ₋₁ / (Pₖ|ₖ₋₁ + R)
 *   update:       x̂ₖ|ₖ = x̂ₖ|ₖ₋₁ + Kₖ (zₖ - x̂ₖ|ₖ₋₁)
 *   error_cov:    Pₖ|ₖ = (1 - Kₖ) Pₖ|ₖ₋₁
 *
 * @param series Input measurements
 * @param Q Process variance (default 1e-5)
 * @param R Measurement variance (default 0.01)
 * @returns Filtered series
 */
function kalmanFilter(series: number[], Q = 1e-5, R = 0.01): number[] {
    if (series.length === 0) return [];

    let x̂ = series[0]; // initial estimate
    let P = 1; // initial error covariance

    const result: number[] = [x̂];

    for (let i = 1; i < series.length; i++) {
        // Prediction step
        const x̂_pred = x̂;
        const P_pred = P + Q;

        // Measurement update
        const K = P_pred / (P_pred + R);
        x̂ = x̂_pred + K * (series[i] - x̂_pred);
        P = (1 - K) * P_pred;

        result.push(x̂);
    }
    return result;
}

// ---------- Input Validation ----------
const seriesValidator = body('series')
    .isArray({ min: 1 })
    .withMessage('series must be a non‑empty array')
    .custom((arr) => arr.every((v: any) => typeof v === 'number' && !isNaN(v)))
    .withMessage('series must contain only numbers');

// ---------- Router ----------
const router = express.Router();

// Apply middlewares to all routes
router.use(express.json());
router.use(authenticateJwt);
router.use(userRateLimiter);

// POST /correlate
router.post(
    '/correlate',
    seriesValidator,
    async (req: AuthenticatedRequest, res: Response) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { series, ...params } = req.body as { series: number[]; [key: string]: any };
        try {
            const filteredSeries = kalmanFilter(series);
            const job = await jobQueue.add(
                'correlate',
                {
                    userId: req.user!.id,
                    series: filteredSeries,
                    params,
                },
                {
                    attempts: 3,
                    backoff: { type: 'exponential', delay: 5000 },
                }
            );
            res.status(202).json({ jobId: job.id });
        } catch (err) {
            console.error('Error enqueuing correlate job:', err);
            res.status(500).json({ error: 'Failed to enqueue correlate job' });
        }
    }
);

// POST /forecast
router.post(
    '/forecast',
    seriesValidator,
    async (req: AuthenticatedRequest, res: Response) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { series, horizon, ...params } = req.body as {
            series: number[];
            horizon?: number;
            [key: string]: any;
        };
        try {
            const filteredSeries = kalmanFilter(series);
            const job = await jobQueue.add(
                'forecast',
                {
                    userId: req.user!.id,
                    series: filteredSeries,
                    horizon: horizon ?? 10,
                    params,
                },
                {
                    attempts: 3,
                    backoff: { type: 'exponential', delay: 5000 },
                }
            );
            res.status(202).json({ jobId: job.id });
        } catch (err) {
            console.error('Error enqueuing forecast job:', err);
            res.status(500).json({ error: 'Failed to enqueue forecast job' });
        }
    }
);

// ---------- Export ----------