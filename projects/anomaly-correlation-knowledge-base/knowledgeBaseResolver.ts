import { GraphQLResolveInfo } from 'graphql';
import NodeCache from 'node-cache';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { orchestratorService } from './services/orchestratorService';
import { driftMonitorService } from './services/driftMonitorService';
import { alertingService } from './services/alertingService';
import { visualizationService } from './services/visualizationService';
import { explainabilityService } from './services/explainabilityService';

// Types for the aggregated anomaly report
export interface OrchestratorData {
  workflowId: string;
  status: string;
  startedAt: string; // ISO string
  finishedAt?: string;
}

export interface DriftData {
  metric: string;
  currentValue: number;
  baselineValue: number;
  driftScore: number; // (|current - baseline|) / baseline
}

export interface AlertData {
  alertId: string;
  severity: string;
  generatedAt: string;
  description: string;
}

export interface VisualizationData {
  chartUrl: string;
  thumbnailUrl?: string;
}

export interface ExplainabilityData {
  rootCause: string;
  confidence: number; // 0..1
  explanation: string;
}

export interface AnomalyReport {
  anomalyId: string;
  orchestrator: OrchestratorData;
  drift: DriftData[];
  alerts: AlertData[];
  visualization: VisualizationData;
  explainability: ExplainableResult;
}

export interface ExplainableResult {
  rootCause: string;
  confidence: number;
  explanation: string;
}

// Cache configuration: 5 minutes TTL, check period 1 minute
const cache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// Rate limiter: max 10 requests per minute per user
const rateLimiter = new RateLimiterMemory({
  points: 10, // 10 points
  duration: 60, // Per 60 seconds
});

/**
 * Validates the anomalyId argument.
 * @param anomalyId - The anomaly identifier to validate.
 * @throws {Error} If validation fails.
 */
function validateAnomalyId(anomalyId: unknown): string {
  if (typeof anomalyId !== 'string' || anomalyId.trim() === '') {
    throw new Error('Invalid argument: anomalyId must be a non‑empty string.');
  }
  // Optional: enforce a specific pattern, e.g., UUID v4
  const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidV4Regex.test(anomalyId)) {
    throw new Error('Invalid argument: anomalyId must be a valid UUID v4.');
  }
  return anomalyId;
}

/**
 * Retrieves data from a service with built‑in error handling.
 * @param fetcher - Async function that returns the desired data.
 * @param serviceName - Human readable name for logging.
 */
async function safeFetch<T>(fetcher: () => Promise<T>, serviceName: string): Promise<T | null> {
  try {
    const result = await fetcher();
    return result;
  } catch (err) {
    // Log the error; in production replace console.error with a proper logger.
    console.error(`Error fetching data from ${serviceName}:`, err);
    return null; // Gracefully degrade by returning null
  }
}

/**
 * GraphQL resolver for the anomalyReport query.
 */
export const knowledgeBaseResolver = {
  Query: {
    async anomalyReport(
      _parent: unknown,
      args: { anomalyId: string },
      context: { userId: string },
      _info: GraphQLResolveInfo
    ): Promise<AnomalyReport> {
      // Rate limiting per user
      try {
        await rateLimiter.consume(context.userId);
      } catch (rlRejected) {
        throw new Error('Rate limit exceeded. Please try again later.');
      }

      // Input validation
      const anomalyId = validateAnomalyId(args.anomalyId);

      // Check cache first
      const cacheKey = `anomalyReport:${anomalyId}`;
      const cached = cache.get<AnomalyReport>(cacheKey);
      if (cached) {
        return cached;
      }

      // Parallel fetching of all service data
      const [
        orchestrator,
        drift,
        alerts,
        visualization,
        explainability,
      ] = await Promise.all([
        safeFetch(() => orchestratorService.getWorkflowByAnomalyId(anomalyId), 'Orchestrator'),
        safeFetch(() => driftMonitorService.getDriftMetrics(anomalyId), 'Drift Monitor'),
        safeFetch(() => alertingService.getAlertsForAnomaly(anomalyId), 'Alerting'),
        safeFetch(() => visualizationService.getVisualization(anomalyId), 'Visualization'),
        safeFetch(() => explainabilityService.getExplanation(anomalyId), 'Explainability'),
      ]);

      // Validate mandatory components
      if (!orchestrator) {
        throw new Error('Failed to retrieve orchestrator data for the given anomaly.');
      }
      if (!visualization) {
        throw new Error('Failed to retrieve visualization data for the given anomaly.');
      }
      if (!explainability) {
        throw new Error('Failed to retrieve explainability data for the given anomaly.');
      }

      // Assemble the unified report
      const report: AnomalyReport = {
        anomalyId,
        orchestrator,
        drift: drift ?? [],
        alerts: alerts ?? [],
        visualization,
        explainability: {
          rootCause: explainability.rootCause,
          confidence: explainability.confidence,
          explanation: explainability.explanation,
        },
      };

      // Store in cache for future requests
      cache.set(cacheKey, report);

      return report;
    },
  },
};