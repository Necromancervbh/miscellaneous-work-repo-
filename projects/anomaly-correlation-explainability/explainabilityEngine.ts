import * as jwt from 'jsonwebtoken';
import PCA from 'ml-pca';
import { promisify } from 'util';

type ExplainabilityRequest = {
    token: string;
    anomalyScore: number;
    timeSeries: number[][]; // rows: observations, columns: features
    featureNames?: string[];
};

type FeatureContribution = {
    feature: string;
    contribution: number;
};

type ExplainabilityResponse = {
    explanations: FeatureContribution[];
};

class ValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ValidationError';
    }
}

/**
 * Validates the incoming request payload.
 * Throws ValidationError if any check fails.
 */
function validateRequest(req: ExplainabilityRequest): void {
    if (typeof req.token !== 'string' || req.token.trim() === '') {
        throw new ValidationError('Invalid or missing JWT token.');
    }
    if (typeof req.anomalyScore !== 'number' || Number.isNaN(req.anomalyScore)) {
        throw new ValidationError('Anomaly score must be a valid number.');
    }
    if (!Array.isArray(req.timeSeries) || req.timeSeries.length === 0) {
        throw new ValidationError('timeSeries must be a non‑empty 2‑dimensional array.');
    }
    const featureCount = req.timeSeries[0].length;
    if (featureCount === 0) {
        throw new ValidationError('timeSeries must contain at least one feature per observation.');
    }
    for (let i = 0; i < req.timeSeries.length; i++) {
        const row = req.timeSeries[i];
        if (!Array.isArray(row) || row.length !== featureCount) {
            throw new ValidationError('All rows in timeSeries must have the same number of features.');
        }
        for (let j = 0; j < row.length; j++) {
            if (typeof row[j] !== 'number' || Number.isNaN(row[j])) {
                throw new ValidationError(`timeSeries contains non‑numeric value at row ${i}, column ${j}.`);
            }
        }
    }
    if (req.featureNames) {
        if (!Array.isArray(req.featureNames) || req.featureNames.length !== featureCount) {
            throw new ValidationError('featureNames length must match number of features.');
        }
        for (const name of req.featureNames) {
            if (typeof name !== 'string' || name.trim() === '') {
                throw new ValidationError('All featureNames must be non‑empty strings.');
            }
        }
    }
}

/**
 * Verifies the JWT token using the secret from environment variables.
 * Returns the decoded payload if verification succeeds.
 */
async function verifyToken(token: string): Promise<any> {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        throw new Error('JWT_SECRET environment variable is not set.');
    }
    const verifyAsync = promisify<string, jwt.Secret, jwt.VerifyOptions, any>(jwt.verify);
    try {
        const decoded = await verifyAsync(token, secret, { algorithms: ['HS256'] });
        return decoded;
    } catch (err) {
        throw new ValidationError('JWT verification failed.');
    }
}

/**
 * Computes SHAP‑like contributions for each original feature.
 *
 * Formula (simplified):
 *   contribution_i = | anomalyScore * Σ_j (loading_{i,j} * projection_j) |
 *
 * where:
 *   loading_{i,j} = component matrix entry (feature i, component j)
 *   projection_j   = transformed value of component j for the current observation
 *
 * The absolute value emphasizes magnitude irrespective of direction.
 */
function computeFeatureContributions(
    pca: PCA,
    projection: number[],
    anomalyScore: number
): number[] {
    const loadings = pca.getLoadings(); // matrix [features][components]
    const featureCount = loadings.length;
    const componentCount = loadings[0].length;
    const contributions: number[] = new Array(featureCount).fill(0);

    for (let i = 0; i < featureCount; i++) {
        let sum = 0;
        for (let j = 0; j < componentCount; j++) {
            sum += loadings[i][j] * projection[j];
        }
        contributions[i] = Math.abs(anomalyScore * sum);
    }
    return contributions;
}

/**
 * Main entry point exposed to callers.
 * Performs JWT validation, PCA reduction, contribution calculation,
 * and returns a JSON‑serializable explanation object.
 */
export async function explainAnomaly(request: ExplainabilityRequest): Promise<ExplainabilityResponse> {
    // Input validation
    validateRequest(request);

    // JWT validation
    await verifyToken(request.token);

    // PCA configuration
    const desiredComponents = 3; // can be tuned; ensures at most min(observations, features)
    const observations = request.timeSeries;
    const featureCount = observations[0].length;
    const componentCount = Math.min(desiredComponents, observations.length, featureCount);

    // Perform PCA
    const pca = new PCA(observations, { center: true, scale: true, nComp: componentCount });

    // Transform the latest observation (assumed to be the last row) into component space
    const latestObservation = observations[observations.length - 1];
    const projection = pca.predict([latestObservation])[0]; // returns array of component values

    // Compute feature contributions
    const rawContributions = computeFeatureContributions(pca, projection, request.anomalyScore);

    // Normalize contributions to sum to 1 for interpretability
    const total = rawContributions.reduce((acc, val) => acc + val, 0);
    const normalized = total > 0 ? rawContributions.map(v => v / total) : rawContributions.map(() => 0);

    // Build response
    const explanations: FeatureContribution[] = normalized.map((contrib, idx) => ({
        feature: request.featureNames ? request.featureNames[idx] : `feature_${idx}`,
        contribution: Number(contrib.toFixed(6)) // limit precision for JSON payload
    }));

    return { explanations };
}