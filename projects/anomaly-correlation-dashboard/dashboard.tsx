import React, { useEffect, useRef, useState } from "react";
import type { FC } from "react";

/**
 * Configuration constants
 */
const WS_URL = process.env.REACT_APP_WS_URL || "wss://example.com/notifier";
const JWT_STORAGE_KEY = "auth_token";
const K_CLUSTERS = 3; // Number of clusters for K‑Means
const MAX_MESSAGES_PER_SEC = 10; // Rate limit for incoming messages

/**
 * Types
 */
interface RawMessage {
  /** Unique identifier of the event */
  id: string;
  /** Numeric value(s) used for clustering */
  values: number[];
  /** Original timestamp (ms since epoch) */
  timestamp: number;
}

interface DataPoint {
  id: string;
  values: number[];
  /** Smoothed timestamp after Kalman filter */
  timestamp: number;
}

/**
 * Simple Kalman filter for one‑dimensional timestamp smoothing.
 *
 * The filter equations:
 *   predict:   x̂ₖ|ₖ₋₁ = x̂ₖ₋₁
 *   predict:   Pₖ|ₖ₋₁ = Pₖ₋₁ + Q
 *   update:    Kₖ = Pₖ|ₖ₋₁ / (Pₖ|ₖ₋₁ + R)
 *   update:    x̂ₖ = x̂ₖ|ₖ₋₁ + Kₖ (zₖ - x̂ₖ|ₖ₋₁)
 *   update:    Pₖ = (1 - Kₖ) Pₖ|ₖ₋₁
 *
 * Q – process variance, R – measurement variance.
 */
class KalmanFilter {
  private estimate: number;
  private errorCovariance: number;
  private readonly processVariance: number;
  private readonly measurementVariance: number;

  constructor(initialEstimate: number, processVariance = 1e-3, measurementVariance = 1) {
    this.estimate = initialEstimate;
    this.errorCovariance = 1;
    this.processVariance = processVariance;
    this.measurementVariance = measurementVariance;
  }

  public filter(measurement: number): number {
    // Predict
    const priorEstimate = this.estimate;
    const priorErrorCov = this.errorCovariance + this.processVariance;

    // Update
    const kalmanGain = priorErrorCov / (priorErrorCov + this.measurementVariance);
    this.estimate = priorEstimate + kalmanGain * (measurement - priorEstimate);
    this.errorCovariance = (1 - kalmanGain) * priorErrorCov;

    return this.estimate;
  }
}

/**
 * Simple K‑Means implementation.
 *
 * @param points Array of numeric vectors.
 * @param k Number of clusters.
 * @param maxIter Maximum iterations.
 * @returns Array of cluster assignments (index per point) and centroids.
 */
function kMeans(
  points: number[][],
  k: number,
  maxIter = 100
): { assignments: number[]; centroids: number[][] } {
  if (k <= 0) {
    throw new Error("Number of clusters k must be greater than 0.");
  }
  if (points.length < k) {
    throw new Error("Number of points must be at least equal to k.");
  }

  // Helper: Euclidean distance squared
  const distSq = (a: number[], b: number[]) => {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      const d = a[i] - b[i];
      sum += d * d;
    }
    return sum;
  };

  // Initialize centroids by random distinct points
  const centroids: number[][] = [];
  const usedIdx = new Set<number>();
  while (centroids.length < k) {
    const idx = Math.floor(Math.random() * points.length);
    if (!usedIdx.has(idx)) {
      usedIdx.add(idx);
      centroids.push([...points[idx]]);
    }
  }

  let assignments = new Array<number>(points.length).fill(-1);
  for (let iter = 0; iter < maxIter; iter++) {
    // Assignment step
    let changed = false;
    for (let i = 0; i < points.length; i++) {
      const point = points[i];
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        const d = distSq(point, centroids[c]);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = c;
        }
      }
      if (assignments[i] !== bestIdx) {
        changed = true;
        assignments[i] = bestIdx;
      }
    }

    // Update step
    const newCentroids = Array.from({ length: k }, () => new Array<number>(points[0].length).fill(0));
    const counts = new Array<number>(k).fill(0);
    for (let i = 0; i < points.length; i++) {
      const cluster = assignments[i];
      const point = points[i];
      counts[cluster] += 1;
      for (let d = 0; d < point.length; d++) {
        newCentroids[cluster][d] += point[d];
      }
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue; // avoid division by zero
      for (let d = 0; d < newCentroids[c].length; d++) {
        newCentroids[c][d] /= counts[c];
      }
    }

    // Check convergence
    let centroidShift = 0;
    for (let c = 0; c < k; c++) {
      centroidShift += Math.sqrt(distSq(centroids[c], newCentroids[c]));
    }
    centroids.splice(0, centroids.length, ...newCentroids);
    if (!changed || centroidShift < 1e-6) {
      break;
    }
  }

  return { assignments, centroids };
}

/**
 * Rate limiter based on token bucket algorithm.
 */
class RateLimiter {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillRate: number; // tokens per ms
  private lastRefill: number;

  constructor(messagesPerSec: number) {
    this.capacity = messagesPerSec;
    this.tokens = messagesPerSec;
    this.refillRate = messagesPerSec / 1000;
    this.lastRefill = Date.now();
  }

  public tryRemoveToken(): boolean {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

/**
 * JWT validation utilities.
 */
function getStoredToken(): string | null {
  try {
    return localStorage.getItem(JWT_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Simple JWT expiration check (no signature verification on client side).
 */
function isTokenValid(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    if (!payload.exp) return false;
    const now = Math.floor(Date