import React, { useEffect, useRef, useState } from "react";
import * as d3 from "d3";
import DBSCAN from "density-clustering"; // npm install density-clustering
// Ensure TypeScript knows the module
declare module "density-clustering" {
  export default class DBSCAN {
    constructor();
    run(
      data: number[][],
      eps: number,
      minPts: number
    ): number[][]; // returns array of clusters (each cluster is array of point indices)
    noise: number[]; // indices of noise points
  }
}

/**
 * Simple Kalman filter for a single scalar series.
 * Equations:
 *   Predict:   x̂ₖ|ₖ₋₁ = x̂ₖ₋₁|ₖ₋₁
 *   Predict:   Pₖ|ₖ₋₁ = Pₖ₋₁|ₖ₋₁ + Q
 *   Update:    Kₖ = Pₖ|ₖ₋₁ / (Pₖ|ₖ₋₁ + R)
 *   Update:    x̂ₖ|ₖ = x̂ₖ|ₖ₋₁ + Kₖ (zₖ - x̂ₖ|ₖ₋₁)
 *   Update:    Pₖ|ₖ = (1 - Kₖ) Pₖ|ₖ₋₁
 */
class KalmanScalar {
  private estimate: number;
  private errorCovariance: number;
  private readonly processNoise: number;
  private readonly measurementNoise: number;

  constructor(initialValue: number, processNoise = 1e-3, measurementNoise = 1e-1) {
    this.estimate = initialValue;
    this.errorCovariance = 1;
    this.processNoise = processNoise;
    this.measurementNoise = measurementNoise;
  }

  update(measurement: number): number {
    // Predict step (no control input)
    const predEstimate = this.estimate;
    const predErrorCov = this.errorCovariance + this.processNoise;

    // Update step
    const kalmanGain = predErrorCov / (predErrorCov + this.measurementNoise);
    this.estimate = predEstimate + kalmanGain * (measurement - predEstimate);
    this.errorCovariance = (1 - kalmanGain) * predErrorCov;

    return this.estimate;
  }
}

/**
 * Interface for incoming WebSocket messages.
 */
interface AnomalyMessage {
  timestamp: number; // Unix epoch ms
  vector: number[];
}

/**
 * Processed point after Kalman filtering.
 */
interface ProcessedPoint {
  timestamp: number;
  vector: number[];
  clusterId: number | null; // null for noise/unclustered
}

/**
 * Props for Dashboard component.
 */
interface DashboardProps {
  /** WebSocket URL (e.g., wss://api.example.com/anomalies) */
  wsUrl: string;
  /** Number of recent points to keep for clustering (window size) */
  clusteringWindow?: number;
  /** DBSCAN epsilon parameter (distance threshold) */
  dbscanEps?: number;
  /** DBSCAN minimum points per cluster */
  dbscanMinPts?: number;
}

/**
 * React component that visualizes real‑time anomaly vectors.
 */
export default function Dashboard({
  wsUrl,
  clusteringWindow = 300,
  dbscanEps = 5,
  dbscanMinPts = 3,
}: DashboardProps): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null);
  const [points, setPoints] = useState<ProcessedPoint[]>([]);
  const kalmanFiltersRef = useRef<KalmanScalar[] | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Initialize WebSocket connection
  useEffect(() => {
    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        console.info("WebSocket connection opened.");
      };

      ws.onmessage = (event) => {
        try {
          const data: unknown = JSON.parse(event.data);
          if (
            typeof data === "object" &&
            data !== null &&
            "timestamp" in data &&
            "vector" in data &&
            typeof (data as any).timestamp === "number" &&
            Array.isArray((data as any).vector) &&
            (data as any).vector.every((v: any) => typeof v === "number")
          ) {
            const msg = data as AnomalyMessage;
            handleIncomingMessage(msg);
          } else {
            console.warn("Invalid message format:", event.data);
          }
        } catch (e) {
          console.error("Failed to parse WebSocket message:", e);
        }
      };

      ws.onerror = (ev) => {
        console.error("WebSocket error:", ev);
      };

      ws.onclose = (ev) => {
        console.info(`WebSocket closed (code=${ev.code}).`);
      };

      return () => {
        ws.close();
      };
    } catch (e) {
      console.error("Failed to create WebSocket:", e);
    }
  }, [wsUrl]);

  // Process incoming anomaly message
  const handleIncomingMessage = (msg: AnomalyMessage) => {
    // Initialize Kalman filters on first message
    if (!kalmanFiltersRef.current) {
      kalmanFiltersRef.current = msg.vector.map(
        (v) => new KalmanScalar(v)
      );
    }

    const filters = kalmanFiltersRef.current!;
    if (filters.length !== msg.vector.length) {
      console.error(
        `Dimension mismatch: expected ${filters.length}, got ${msg.vector.length}`
      );
      return;
    }

    // Apply Kalman filter per dimension
    const filteredVector = msg.vector.map((value, idx) =>
      filters[idx].update(value)
    );

    // Append to points state (maintain window size)
    setPoints((prev) => {
      const newPoints = [
        ...prev,
        { timestamp: msg.timestamp, vector: filteredVector, clusterId: null },
      ];
      if (newPoints.length > clusteringWindow) {
        newPoints.splice(0, newPoints.length - clusteringWindow);
      }
      // Re‑run clustering on the updated window
      const clustered = runClustering(newPoints);
      return clustered;
    });
  };

  // Run DBSCAN clustering on the latest points
  const runClustering = (data: ProcessedPoint[]): ProcessedPoint[] => {
    if (data.length === 0) return data;

    const vectors = data.map((p) => p.vector);
    const dbscan = new DBSCAN();
    const clusters = dbscan.run(vectors, dbscanEps, dbscanMinPts);
    const noise = dbscan.noise;

    // Assign cluster IDs (0‑based). Noise gets null.
    const clusterMap = new Map<number