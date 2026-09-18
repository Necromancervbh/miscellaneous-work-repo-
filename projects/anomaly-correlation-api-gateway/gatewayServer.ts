import express, { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload } from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import LRUCache from 'lru-cache';
import PQueue from 'p-queue';
import dotenv from 'dotenv';
import { getDashboardData } from './dashboard';
import { getOrchestratorData } from './orchestrator';
import { getExplainabilityData } from './explainability';
import { merge } from 'lodash';

dotenv.config();

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('JWT_SECRET environment variable is required');
  process.exit(1);
}

// ---------- JWT Authentication Middleware ----------
interface AuthenticatedRequest extends Request {
  user?: string | JwtPayload;
}

function authenticateToken(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Missing token' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.user = user;
    next();
  });
}

// ---------- Rate Limiting ----------
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // limit each IP to 60 requests per windowMs
  handler: (_, res) => {
    res.status(429).json({ error: 'Too many requests, please try again later.' });
  },
});

// ---------- LRU Cache ----------
const cache = new LRUCache<string, any>({
  max: 500, // max 500 items
  ttl: 1000 * 60 * 5, // 5 minutes TTL
});

// ---------- Async Task Queue ----------
const queue = new PQueue({ concurrency: 5 }); // up to 5 concurrent tasks

// ---------- Helper Functions ----------
function validateAnalysisParams(req: Request): { valid: boolean; errors?: string[]; key?: string } {
  const errors: string[] = [];
  const { startTime, endTime, entityId } = req.query;

  if (!startTime || typeof startTime !== 'string') {
    errors.push('startTime query parameter is required and must be a string.');
  }
  if (!endTime || typeof endTime !== 'string') {
    errors.push('endTime query parameter is required and must be a string.');
  }
  if (!entityId || typeof entityId !== 'string') {
    errors.push('entityId query parameter is required and must be a string.');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Create a deterministic cache key based on parameters
  const key = `analysis:${entityId}:${startTime}:${endTime}`;
  return { valid: true, key };
}

// ---------- Route Handlers ----------
async function handleAnalysis(req: AuthenticatedRequest, res: Response) {
  const validation = validateAnalysisParams(req);
  if (!validation.valid) {
    return res.status(400).json({ errors: validation.errors });
  }

  const cacheKey = validation.key!;
  const cachedResult = cache.get(cacheKey);
  if (cachedResult) {
    return res.json(cachedResult);
  }

  // Enqueue the heavy computation
  try {
    const result = await queue.add(async () => {
      const [dashboard, orchestrator, explainability] = await Promise.all([
        getDashboardData(req.query as any),
        getOrchestratorData(req.query as any),
        getExplainabilityData(req.query as any),
      ]);

      // Deep merge the three JSON objects
      // Formula: merged = dashboard ⊕ orchestrator ⊕ explainability
      const merged = merge({}, dashboard, orchestrator, explainability);
      return merged;
    });

    cache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('Error processing analysis request:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// ---------- Express App Setup ----------
const app = express();

app.use(express.json());
app.use(limiter);
app.use(authenticateToken);

// Health check endpoint (no auth)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Analysis endpoint
app.get('/analysis', handleAnalysis);

// Global error handler
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Unexpected error occurred' });
});

// ---------- Server Start ----------
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Gateway server listening on port ${PORT}`);
  });
}

export default app;