import express, { Request, Response, NextFunction, Router } from 'express';
import axios, { AxiosResponse } from 'axios';
import { v4 as uuidv4, validate as uuidValidate } from 'uuid';
import { Pool, QueryResult } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Type representing a feature vector where each key is a feature name
 * and the value is its numeric value.
 */
type FeatureVector = Record<string, number>;

/**
 * Response format from the Python SHAP microservice.
 * Expected to contain a mapping from feature name to SHAP value.
 */
interface ShapResponse {
  shapValues: Record<string, number>;
}

/**
 * Ranked factor contributed to a prediction.
 */
interface RankedFactor {
  feature: string;
  shapValue: number;
}

/**
 * Service responsible for handling explainability requests.
 */
class ExplainabilityService {
  private router: Router;
  private dbPool: Pool;
  private pythonServiceUrl: string;

  constructor() {
    this.router = express.Router();
    this.dbPool = new Pool({
      connectionString: process.env.DATABASE_URL,
    });
    this.pythonServiceUrl = process.env.PYTHON_SHAP_SERVICE_URL || 'http://localhost:5000/shap';
    this.initializeRoutes();
  }

  /**
   * Exposes the router to be used by the main application.
   */
  public getRouter(): Router {
    return this.router;
  }

  /**
   * Sets up the endpoint routes.
   */
  private initializeRoutes(): void {
    this.router.get(
      '/explain/:predictionId',
      this.validatePredictionId.bind(this),
      this.handleExplain.bind(this)
    );
  }

  /**
   * Middleware to validate that the predictionId path param is a valid UUID.
   */
  private validatePredictionId(req: Request, res: Response, next: NextFunction): void {
    const { predictionId } = req.params;
    if (!predictionId || !uuidValidate(predictionId)) {
      res.status(400).json({ error: 'Invalid predictionId. Must be a UUID.' });
      return;
    }
    next();
  }

  /**
   * Main handler for the explainability request.
   */
  private async handleExplain(req: Request, res: Response): Promise<void> {
    const { predictionId } = req.params;

    try {
      const featureVector = await this.fetchFeatureVector(predictionId);
      if (!featureVector) {
        res.status(404).json({ error: `Feature vector not found for predictionId ${predictionId}` });
        return;
      }

      const shapValues = await this.computeShapValues(featureVector);
      const rankedFactors = this.rankFactors(shapValues);

      res.status(200).json({ predictionId, rankedFactors });
    } catch (error) {
      console.error('Explainability error:', error);
      if (axios.isAxiosError(error) && error.response) {
        res
          .status(error.response.status)
          .json({ error: error.response.data?.error || 'Error from SHAP service' });
      } else {
        res.status(500).json({ error: 'Internal server error while processing explanation.' });
      }
    }
  }

  /**
   * Retrieves the feature vector for a given prediction ID from the database.
   * @param predictionId UUID of the prediction.
   * @returns FeatureVector or null if not found.
   */
  private async fetchFeatureVector(predictionId: string): Promise<FeatureVector | null> {
    const query = `
      SELECT feature_name, feature_value
      FROM prediction_features
      WHERE prediction_id = $1
    `;
    const result: QueryResult = await this.dbPool.query(query, [predictionId]);

    if (result.rowCount === 0) {
      return null;
    }

    const vector: FeatureVector = {};
    for (const row of result.rows) {
      vector[row.feature_name] = parseFloat(row.feature_value);
    }
    return vector;
  }

  /**
   * Calls the external Python microservice to compute SHAP values.
   * @param featureVector Input feature vector.
   * @returns Mapping of feature name to SHAP value.
   */
  private async computeShapValues(featureVector: FeatureVector): Promise<Record<string, number>> {
    const payload = { features: featureVector };
    const response: AxiosResponse<ShapResponse> = await axios.post(this.pythonServiceUrl, payload, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.data || typeof response.data.shapValues !== 'object') {
      throw new Error('Invalid response format from SHAP service.');
    }

    // Ensure all values are numbers
    const shapValues: Record<string, number> = {};
    for (const [key, value] of Object.entries(response.data.shapValues)) {
      const num = Number(value);
      if (Number.isNaN(num)) {
        throw new Error(`Non-numeric SHAP value received for feature ${key}.`);
      }
      shapValues[key] = num;
    }

    return shapValues;
  }

  /**
   * Ranks features by absolute SHAP value descending.
   * Formula: rank = sort(|shapValue|) descending.
   * @param shapValues Mapping of feature to SHAP value.
   * @returns Ordered list of RankedFactor.
   */
  private rankFactors(shapValues: Record<string, number>): RankedFactor[] {
    const factors: RankedFactor[] = Object.entries(shapValues).map(([feature, shapValue]) => ({
      feature,
      shapValue,
    }));

    factors.sort((a, b) => Math.abs(b.shapValue) - Math.abs(a.shapValue));
    return factors;
  }
}

// Export an instantiated router for integration with the main Express app.
const explainabilityService = new ExplainabilityService();
export default explainabilityService.getRouter();