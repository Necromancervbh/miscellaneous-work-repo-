import * as d3 from 'd3';
import { PCA } from 'ml-pca';
import { stl } from 'ml-stl';
import canvg from 'canvg';

/**
 * Types
 */
export interface AnomalyMessage {
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** Array of anomaly scores for each dimension */
  scores: number[];
}

/**
 * Configuration for the VisualizationService
 */
export interface VisualizationConfig {
  /** DOM element (or selector) where the chart will be rendered */
  container: string | HTMLElement;
  /** WebSocket endpoint URL */
  wsUrl: string;
  /** Number of recent points to keep for analysis (default: 500) */
  bufferSize?: number;
  /** Width of the SVG chart (default: 800) */
  width?: number;
  /** Height of the SVG chart (default: 600) */
  height?: number;
}

/**
 * VisualizationService
 *
 * Consumes streamed anomaly scores via WebSocket, applies STL decomposition
 * and PCA for dimensionality reduction, and renders an interactive D3 chart
 * with drill‑down tooltips and PNG export.
 */
export class VisualizationService {
  private readonly wsUrl: string;
  private readonly container: HTMLElement;
  private readonly bufferSize: number;
  private readonly width: number;
  private readonly height: number;

  private socket: WebSocket | null = null;
  private dataBuffer: AnomalyMessage[] = [];

  // D3 selections
  private svg: d3.Selection<SVGSVGElement, unknown, null, undefined> | null = null;
  private tooltip: d3.Selection<HTMLDivElement, unknown, null, undefined> | null = null;
  private exportButton: HTMLButtonElement | null = null;

  /**
   * Create a new VisualizationService.
   * @param config Service configuration.
   */
  constructor(config: VisualizationConfig) {
    if (!config || typeof config !== 'object') {
      throw new Error('VisualizationConfig must be a non‑null object');
    }
    if (!config.wsUrl || typeof config.wsUrl !== 'string') {
      throw new Error('wsUrl must be a non‑empty string');
    }
    if (!config.container) {
      throw new Error('container must be provided');
    }

    this.wsUrl = config.wsUrl;
    this.bufferSize = config.bufferSize ?? 500;
    this.width = config.width ?? 800;
    this.height = config.height ?? 600;

    // Resolve container element
    if (typeof config.container === 'string') {
      const el = document.querySelector<HTMLElement>(config.container);
      if (!el) {
        throw new Error(`Container element not found for selector "${config.container}"`);
      }
      this.container = el;
    } else if (config.container instanceof HTMLElement) {
      this.container = config.container;
    } else {
      throw new Error('container must be a selector string or an HTMLElement');
    }

    this.initializeChart();
  }

  /**
   * Initialize SVG chart, tooltip, and export button.
   */
  private initializeChart(): void {
    // Clear container
    this.container.innerHTML = '';

    // Create SVG
    this.svg = d3
      .select(this.container)
      .append('svg')
      .attr('width', this.width)
      .attr('height', this.height)
      .style('border', '1px solid #ccc')
      .style('background-color', '#fff');

    // Create tooltip
    this.tooltip = d3
      .select(this.container)
      .append('div')
      .style('position', 'absolute')
      .style('pointer-events', 'none')
      .style('background', 'rgba(0,0,0,0.7)')
      .style('color', '#fff')
      .style('padding', '6px')
      .style('border-radius', '4px')
      .style('font-size', '12px')
      .style('opacity', '0');

    // Create export button
    this.exportButton = document.createElement('button');
    this.exportButton.textContent = 'Export PNG';
    this.exportButton.style.marginTop = '8px';
    this.exportButton.addEventListener('click', () => this.exportPNG());
    this.container.appendChild(this.exportButton);
  }

  /**
   * Start the WebSocket connection and begin processing data.
   */
  public start(): void {
    if (this.socket) {
      console.warn('WebSocket already started');
      return;
    }

    try {
      this.socket = new WebSocket(this.wsUrl);
    } catch (err) {
      console.error('Failed to create WebSocket:', err);
      return;
    }

    this.socket.addEventListener('open', () => {
      console.info('WebSocket connection opened');
    });

    this.socket.addEventListener('message', (event) => {
      this.handleMessage(event.data);
    });

    this.socket.addEventListener('error', (event) => {
      console.error('WebSocket error:', event);
    });

    this.socket.addEventListener('close', (event) => {
      console.info(`WebSocket closed (code=${event.code})`);
      this.socket = null;
    });
  }

  /**
   * Stop the WebSocket connection.
   */
  public stop(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
  }

  /**
   * Parse and validate incoming message, then update the buffer and chart.
   * @param rawData Raw data received from WebSocket.
   */
  private handleMessage(rawData: any): void {
    let msg: AnomalyMessage;
    try {
      const parsed = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
      if (
        typeof parsed !== 'object' ||
        typeof parsed.timestamp !== 'number' ||
        !Array.isArray(parsed.scores) ||
        !parsed.scores.every((v: any) => typeof v === 'number')
      ) {
        throw new Error('Invalid message format');
      }
      msg = {
        timestamp: parsed.timestamp,
        scores: parsed.scores,
      };
    } catch (err) {
      console.warn('Failed to parse incoming message:', err);
      return;
    }

    // Add to buffer
    this.dataBuffer.push(msg);
    if (this.dataBuffer.length > this.bufferSize) {
      this.dataBuffer.shift();
    }

    // Process and render
    this.processAndRender();
  }

  /**
   * Apply STL decomposition to each dimension, then PCA on residuals,
   * and finally render the scatter plot.
   */
  private processAndRender(): void {
    if (this.dataBuffer.length === 0) {
      return;
    }

    // Build matrix: rows = time points, columns = dimensions
    const matrix: number[][] = this.dataBuffer.map((msg) => msg.scores);

    // Apply STL decomposition per column
    const residuals: number[][] = [];
    const period = 24; // Example: assume daily seasonality for hourly data
    const seasonal = 13; // STL parameter (window length)
    const trend = 13; // STL parameter (window length)

    // Formula: X = Trend + Seasonal + Residual
    // We keep only Residual for PCA.
    for (let col = 0; col < matrix[0].length; col++) {