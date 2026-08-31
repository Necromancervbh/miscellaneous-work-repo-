import WebSocket from 'ws';
import axios, { AxiosInstance } from 'axios';
import LRUCache from 'lru-cache';
import jwt from 'jsonwebtoken';
import { EventEmitter } from 'events';

/**
 * Interfaces for incoming anomaly detection results.
 */
interface KalmanResult {
  id: string;
  timestamp: number; // Unix epoch ms
  value: number;
  variance: number;
  [key: string]: any;
}

interface DBSCANResult {
  id: string;
  timestamp: number; // Unix epoch ms
  clusterId: number;
  points: any[];
  [key: string]: any;
}

/**
 * Unified alert after merging Kalman and DBSCAN results.
 */
export interface UnifiedAlert {
  id: string;
  timestamp: number;
  kalman?: KalmanResult;
  dbscan?: DBSCANResult;
  mergedScore?: number; // Example derived metric
}

/**
 * Configuration required for the Aggregator.
 */
export interface AggregatorConfig {
  /** WebSocket URL of the orchestrator */
  wsUrl: string;
  /** HTTP endpoint to POST unified alerts */
  endpointUrl: string;
  /** Secret or private key for signing JWT */
  jwtSecret: string;
  /** JWT expiration in seconds (default 300) */
  jwtExpiresIn?: number;
  /** Maximum size of deduplication LRU cache (default 1000) */
  cacheSize?: number;
  /** Optional custom Axios instance */
  httpClient?: AxiosInstance;
}

/**
 * Aggregator class that consumes WebSocket streams, merges results,
 * deduplicates alerts, and emits them via a JWT‑protected endpoint.
 */
export class Aggregator extends EventEmitter {
  private readonly config: Required<AggregatorConfig>;
  private ws?: WebSocket;
  private readonly httpClient: AxiosInstance;
  private readonly cache: LRUCache<string, true>;
  private readonly pending: Map<string, Partial<UnifiedAlert>> = new Map();
  private reconnectTimeout?: NodeJS.Timeout;
  private stopped = false;

  constructor(config: AggregatorConfig) {
    super();
    this.validateConfig(config);
    this.config = {
      jwtExpiresIn: 300,
      cacheSize: 1000,
      httpClient: axios.create(),
      ...config,
    };
    this.httpClient = this.config.httpClient;
    this.cache = new LRUCache<string, true>({ max: this.config.cacheSize });
  }

  /**
   * Starts the WebSocket connection and begins processing.
   */
  public start(): void {
    if (this.stopped) {
      throw new Error('Aggregator has been stopped and cannot be restarted.');
    }
    this.connectWebSocket();
  }

  /**
   * Gracefully stops the aggregator, closing connections.
   */
  public stop(): void {
    this.stopped = true;
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = undefined;
    }
    this.pending.clear();
    this.cache.reset();
  }

  /**
   * Validates configuration parameters.
   */
  private validateConfig(config: AggregatorConfig): void {
    if (!config.wsUrl || typeof config.wsUrl !== 'string') {
      throw new Error('Invalid wsUrl in configuration.');
    }
    if (!config.endpointUrl || typeof config.endpointUrl !== 'string') {
      throw new Error('Invalid endpointUrl in configuration.');
    }
    if (!config.jwtSecret || typeof config.jwtSecret !== 'string') {
      throw new Error('Invalid jwtSecret in configuration.');
    }
    if (config.cacheSize !== undefined && (!Number.isInteger(config.cacheSize) || config.cacheSize <= 0)) {
      throw new Error('cacheSize must be a positive integer.');
    }
    if (config.jwtExpiresIn !== undefined && (!Number.isInteger(config.jwtExpiresIn) || config.jwtExpiresIn <= 0)) {
      throw new Error('jwtExpiresIn must be a positive integer.');
    }
  }

  /**
   * Establishes a WebSocket connection with automatic reconnection.
   */
  private connectWebSocket(): void {
    this.ws = new WebSocket(this.config.wsUrl);

    this.ws.on('open', () => {
      this.emit('ws_open');
      console.info('WebSocket connection opened.');
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      this.handleMessage(data);
    });

    this.ws.on('error', (err) => {
      console.error('WebSocket error:', err);
      this.emit('ws_error', err);
    });

    this.ws.on('close', (code, reason) => {
      console.warn(`WebSocket closed (code=${code}, reason=${reason.toString()}).`);
      this.emit('ws_close', { code, reason });
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });
  }

  /**
   * Schedules a reconnection attempt after a delay.
   */
  private scheduleReconnect(): void {
    const delay = 5000; // 5 seconds
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }
    this.reconnectTimeout = setTimeout(() => {
      console.info('Attempting to reconnect WebSocket...');
      this.connectWebSocket();
    }, delay);
  }

  /**
   * Handles incoming WebSocket messages.
   */
  private async handleMessage(rawData: WebSocket.Data): Promise<void> {
    let parsed: any;
    try {
      const str = typeof rawData === 'string' ? rawData : rawData.toString('utf8');
      parsed = JSON.parse(str);
    } catch (e) {
      console.error('Failed to parse incoming message as JSON:', e);
      return;
    }

    if (!parsed.type || !parsed.payload) {
      console.warn('Invalid message format: missing type or payload.');
      return;
    }

    const { type, payload } = parsed;

    if (type === 'kalman') {
      this.processKalmanResult(payload);
    } else if (type === 'dbscan') {
      this.processDBSCANResult(payload);
    } else {
      console.warn(`Unsupported message type: ${type}`);
    }
  }

  /**
   * Processes a Kalman filter result.
   */
  private processKalmanResult(payload: any): void {
    if (!this.isValidKalmanResult(payload)) {
      console.warn('Invalid Kalman result payload:', payload);
      return;
    }
    const result: KalmanResult = payload;
    this.mergeResult(result.id, { kalman: result, timestamp: result.timestamp });
  }

  /**
   * Processes a DBSCAN result.
   */
  private processDBSCANResult(payload: any): void {
    if (!this.isValidDBSCANResult(payload)) {
      console.warn('Invalid DBSCAN result payload:', payload);
      return;
    }
    const result: DBSCANResult = payload;
    this.mergeResult(result.id, { dbscan: result, timestamp: result.timestamp });
  }

  /**
   * Validates KalmanResult structure.
   */
  private isValidKalmanResult(obj: any): obj is KalmanResult {
    return (
      obj &&
      typeof obj.id === 'string' &&
      typeof obj.timestamp === 'number' &&
      typeof obj.value === 'number' &&
      typeof obj.variance