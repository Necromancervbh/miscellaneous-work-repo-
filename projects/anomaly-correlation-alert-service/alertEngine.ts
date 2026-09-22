import http from 'http';
import { Server as WebSocketServer, WebSocket } from 'ws';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { EventEmitter } from 'events';
import { z } from 'zod';

// ---------- Configuration Interfaces ----------
interface AlertEngineConfig {
  /** Port for the HTTP/WebSocket server */
  port: number;
  /** Secret or public key for JWT verification */
  jwtSecret: string;
  /** Prior probability of anomaly (0 < p0 < 1) */
  priorAnomalyProb: number;
  /** Variance of the normal observation model */
  normalVariance: number;
  /** Variance of the anomalous observation model (typically larger) */
  anomalyVariance: number;
  /** Thresholds per channel (channelId -> threshold) */
  thresholds: Record<string, number>;
}

/** Kalman filter output message schema */
const KalmanOutputSchema = z.object({
  /** Unique identifier of the source */
  sourceId: z.string(),
  /** Timestamp in ISO format */
  timestamp: z.string().refine((s) => !isNaN(Date.parse(s)), {
    message: 'Invalid timestamp',
  }),
  /** Predicted value from Kalman filter */
  prediction: z.number(),
  /** Observed measurement */
  observation: z.number(),
  /** Estimated variance of the prediction */
  variance: z.number().positive(),
});

/** Internal representation after validation */
type KalmanOutput = z.infer<typeof KalmanOutputSchema>;

/** Alert message sent to clients */
interface AlertMessage {
  sourceId: string;
  timestamp: string;
  anomalyScore: number;
  threshold: number;
  message: string;
}

// ---------- Bayesian Anomaly Detector ----------
class BayesianAnomalyDetector {
  private prior: number;
  private sigma2Normal: number;
  private sigma2Anomaly: number;

  /**
   * @param priorPrior An initial belief of anomaly probability (0 < p0 < 1)
   * @param sigma2Normal Variance of normal observation model
   * @param sigma2Anomaly Variance of anomalous observation model
   */
  constructor(prior: number, sigma2Normal: number, sigma2Anomaly: number) {
    if (prior <= 0 || prior >= 1) {
      throw new Error('Prior anomaly probability must be in (0,1)');
    }
    if (sigma2Normal <= 0 || sigma2Anomaly <= 0) {
      throw new Error('Variances must be positive numbers');
    }
    this.prior = prior;
    this.sigma2Normal = sigma2Normal;
    this.sigma2Anomaly = sigma2Anomaly;
  }

  /**
   * Compute posterior probability that the observation is anomalous.
   *
   * Using Bayes rule:
   *   p(A|x) = (p0 * L_a(x)) / (p0 * L_a(x) + (1-p0) * L_n(x))
   *
   * where L_a and L_n are Gaussian likelihoods:
   *   L(x) = (1 / sqrt(2πσ²)) * exp( -(x - μ)² / (2σ²) )
   *
   * @param prediction Predicted mean μ from Kalman filter
   * @param observation Observed value x
   * @returns Posterior anomaly probability in [0,1]
   */
  computePosterior(prediction: number, observation: number): number {
    const diff = observation - prediction;
    const exponentNormal = -(diff * diff) / (2 * this.sigma2Normal);
    const exponentAnomaly = -(diff * diff) / (2 * this.sigma2Anomaly);

    const likelihoodNormal = Math.exp(exponentNormal) / Math.sqrt(2 * Math.PI * this.sigma2Normal);
    const likelihoodAnomaly = Math.exp(exponentAnomaly) / Math.sqrt(2 * Math.PI * this.sigma2Anomaly);

    const numerator = this.prior * likelihoodAnomaly;
    const denominator = numerator + (1 - this.prior) * likelihoodNormal;

    // Guard against division by zero (should not happen with proper variances)
    if (denominator === 0) {
      return 0;
    }

    return numerator / denominator;
  }
}

// ---------- WebSocket Multiplexer ----------
interface ClientInfo {
  socket: WebSocket;
  channels: Set<string>;
}

/**
 * AlertEngine consumes Kalman filter outputs, computes anomaly scores,
 * and emits alerts over JWT‑protected WebSocket channels.
 */
export class AlertEngine extends EventEmitter {
  private wss: WebSocketServer;
  private httpServer: http.Server;
  private config: AlertEngineConfig;
  private detector: BayesianAnomalyDetector;
  private clients: Map<string, ClientInfo>; // key: client id (socket remote address + port)

  constructor(config: AlertEngineConfig) {
    super();
    this.validateConfig(config);
    this.config = config;
    this.detector = new BayesianAnomalyDetector(
      config.priorAnomalyProb,
      config.normalVariance,
      config.anomalyVariance,
    );
    this.clients = new Map();

    this.httpServer = http.createServer();
    this.wss = new WebSocketServer({ noServer: true });

    this.setupHttpUpgrade();
    this.setupWebSocketHandlers();
  }

  /** Validate configuration values */
  private validateConfig(cfg: AlertEngineConfig) {
    if (cfg.port <= 0 || cfg.port > 65535) {
      throw new Error('Invalid port number');
    }
    if (!cfg.jwtSecret) {
      throw new Error('JWT secret must be provided');
    }
    if (cfg.priorAnomalyProb <= 0 || cfg.priorAnomalyProb >= 1) {
      throw new Error('priorAnomalyProb must be in (0,1)');
    }
    if (cfg.normalVariance <= 0 || cfg.anomalyVariance <= 0) {
      throw new Error('Variances must be positive numbers');
    }
    if (typeof cfg.thresholds !== 'object' || cfg.thresholds === null) {
      throw new Error('thresholds must be an object mapping channelId to number');
    }
    for (const [ch, th] of Object.entries(cfg.thresholds)) {
      if (typeof th !== 'number' || th <= 0 || th > 1) {
        throw new Error(`Threshold for channel ${ch} must be a number in (0,1]`);
      }
    }
  }

  /** Start the underlying HTTP server */
  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer.listen(this.config.port, (err?: any) => {
        if (err) {
          reject(err);
        } else {
          console.info(`AlertEngine listening on port ${this.config.port}`);
          resolve();
        }
      });
    });
  }

  /** Gracefully shut down the server */
  public async stop(): Promise<void> {
    for (const clientInfo of this.clients.values()) {
      clientInfo.socket.terminate();
    }
    this.clients