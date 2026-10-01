import express, { Request, Response, NextFunction } from 'express';
import bodyParser from 'body-parser';
import { PCA } from 'ml-pca';
import DBSCAN from 'ml-dbscan';
import cors from 'cors';
import { json } from 'body-parser';

// ---------- Types ----------
interface Alert {
  timestamp: number; // epoch ms
  values: number[]; // multivariate measurement
}

interface AnalyzeRequestBody {
  alerts: Alert[];
  pcaComponents?: number; // optional, default 2
  dbscanEps?: number; // optional, default 0.5
  dbscanMinPts?: number; // optional, default 5
}

// ---------- Kalman Filter ----------
class KalmanFilter1D {
  private q: number; // process noise covariance
  private r: number; // measurement noise covariance
  private x: number; // estimated value
  private p: number; // estimation error covariance
  private k: number; // kalman gain

  constructor(initialValue: number, q = 1e-5, r = 0.01) {
    this.q = q;
    this.r = r;
    this.x = initialValue;
    this.p = 1;
    this.k = 0;
  }

  /**
   * Update the filter with a new measurement.
   * @param measurement observed value
   * @returns filtered value
   */
  public update(measurement: number): number {
    // Prediction update
    this.p = this.p + this.q;

    // Measurement update
    this.k = this.p / (this.p + this.r);
    this.x = this.x + this.k * (measurement - this.x);
    this.p = (1 - this.k) * this.p;

    return this.x;
  }
}

/**
 * Apply Kalman smoothing to a multivariate time series.
 * @param data array of alerts (ordered by timestamp)
 * @returns smoothed values preserving original structure
 */
function kalmanSmooth(data: Alert[]): Alert[] {
  if (data.length === 0) return [];

  const dim = data[0].values.length;
  const filters: KalmanFilter1D[] = [];

  // Initialize one filter per dimension using first measurement
  for (let d = 0; d < dim; d++) {
    filters.push(new KalmanFilter1D(data[0].values[d]));
  }

  const smoothed: Alert[] = data.map((alert) => {
    const filteredVals = alert.values.map((v, idx) => filters[idx].update(v));
    return { timestamp: alert.timestamp, values: filteredVals };
  });

  return smoothed;
}

// ---------- PCA ----------
/**
 * Reduce dimensionality using PCA.
 * @param data matrix [nSamples][nFeatures]
 * @param components number of principal components to retain
 * @returns transformed matrix [nSamples][components]
 */
function applyPCA(data: number[][], components: number): number[][] {
  const pca = new PCA(data, { center: true, scale: true });
  const reduced = pca.predict(data, { nComponents: components }).to2DArray();
  return reduced;
}

// ---------- DBSCAN ----------
/**
 * Cluster data using DBSCAN.
 * @param data matrix [nSamples][nFeatures]
 * @param eps radius of neighborhood
 * @param minPts minimum points to form a cluster
 * @returns array of cluster labels ( -1 for noise )
 */
function clusterDBSCAN(data: number[][], eps: number, minPts: number): number[] {
  const dbscan = new DBSCAN();
  const clusters = dbscan.run(data, eps, minPts);
  const labels = new Array(data.length).fill(-1);
  clusters.forEach((cluster, idx) => {
    cluster.forEach((pointIdx) => {
      labels[pointIdx] = idx;
    });
  });
  return labels;
}

// ---------- Validation ----------
function validateAnalyzeBody(body: any): { valid: boolean; errors?: string[] } {
  const errors: string[] = [];

  if (!body || typeof body !== 'object') {
    errors.push('Request body must be a JSON object.');
    return { valid: false, errors };
  }

  if (!Array.isArray(body.alerts)) {
    errors.push('`alerts` field must be an array.');
  } else {
    body.alerts.forEach((alert: any, idx: number) => {
      if (typeof alert.timestamp !== 'number' || isNaN(alert.timestamp)) {
        errors.push(`Alert at index ${idx} has invalid or missing 'timestamp'.`);
      }
      if (!Array.isArray(alert.values) || alert.values.some((v: any) => typeof v !== 'number' || isNaN(v))) {
        errors.push(`Alert at index ${idx} has invalid 'values' array.`);
      }
    });
  }

  if (body.pcaComponents !== undefined && (typeof body.pcaComponents !== 'number' || body.pcaComponents <= 0)) {
    errors.push('`pcaComponents` must be a positive number if provided.');
  }

  if (body.dbscanEps !== undefined && (typeof body.dbscanEps !== 'number' || body.dbscanEps <= 0)) {
    errors.push('`dbscanEps` must be a positive number if provided.');
  }

  if (body.dbscanMinPts !== undefined && (typeof body.dbscanMinPts !== 'number' || body.dbscanMinPts <= 0)) {
    errors.push('`dbscanMinPts` must be a positive number if provided.');
  }

  return { valid: errors.length === 0, errors: errors.length ? errors : undefined };
}

// ---------- Express App ----------
const app = express();
app.use(cors());
app.use(bodyParser.json());

// Error handling middleware
function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

/**
 * POST /analyze
 * Body: { alerts: Alert[], pcaComponents?, dbscanEps?, dbscanMinPts? }
 * Returns: { clusters: number[], reducedData: number[][] }
 */
app.post(
  '/analyze',
  asyncHandler(async (req: Request, res: Response) => {
    const validation = validateAnalyzeBody(req.body);
    if (!validation.valid) {
      return res.status(400).json({ error: 'Invalid request', details: validation.errors });
    }

    const {
      alerts,
      pcaComponents = 2,
      dbscanEps = 0.5,
      dbscanMinPts = 5,
    } = req.body as AnalyzeRequestBody;

    // 1. Sort alerts by timestamp to ensure temporal order
    const sortedAlerts = [...alerts].sort((a, b) => a.timestamp - b.timestamp);

    // 2. Apply Kalman filter smoothing
    const smoothedAlerts = kalmanSmooth(sortedAlerts);

    // 3. Extract matrix for PCA (ignore timestamps)
    const matrix = smoothedAlerts.map((a) => a.values);

    // 4. Dimensionality reduction
    const reduced = applyPCA(matrix, pcaComponents);

    // 5. DBSCAN clustering
    const labels = clusterDBSCAN(reduced, dbscanEps, dbscanMinPts);

    // 6. Respond
    res.json({
      clusters: labels,
      reducedData: reduced,
    });
  })
);

// Global error handler
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------- Server ----------
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
app.listen(PORT, () => {
  console.log(`Anomaly Correlation Analytics Engine listening on port ${PORT}`);
});

// ---------- Exported Functions ----------
export {
  kalmanSmooth,
  apply