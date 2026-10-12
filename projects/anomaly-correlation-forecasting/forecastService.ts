import express, { Request, Response, NextFunction } from 'express';
import bodyParser from 'body-parser';
import jwt from 'jsonwebtoken';
import LRUCache from 'lru-cache';
import crypto from 'crypto';

// ---------- Configuration ----------
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const CACHE_MAX_ITEMS = 1000;
const CACHE_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_SEASONAL_PERIOD = 7; // default seasonal period (e.g., weekly)

// ---------- Types ----------
interface ForecastRequestBody {
  timeSeries: number[];
  horizon: number; // number of points to forecast
  seasonalPeriod?: number; // optional, overrides default
}

interface STLDecomposition {
  trend: number[];
  seasonal: number[];
  residual: number[];
}

interface ForecastResult {
  forecast: number[];
  confidence?: number[]; // optional confidence intervals
}

// ---------- Utilities ----------
function validateForecastRequest(body: any): body is ForecastRequestBody {
  if (
    typeof body !== 'object' ||
    !Array.isArray(body.timeSeries) ||
    typeof body.horizon !== 'number'
  ) {
    return false;
  }
  if (body.timeSeries.length < 2) return false;
  if (!Number.isInteger(body.horizon) || body.horizon <= 0) return false;
  if (body.seasonalPeriod !== undefined) {
    if (
      !Number.isInteger(body.seasonalPeriod) ||
      body.seasonalPeriod <= 0 ||
      body.seasonalPeriod > body.timeSeries.length
    ) {
      return false;
    }
  }
  return true;
}

function hashRequest(body: ForecastRequestBody): string {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(body));
  return hash.digest('hex');
}

// Simple moving average for trend estimation
function movingAverage(data: number[], window: number): number[] {
  const result: number[] = [];
  const half = Math.floor(window / 2);
  for (let i = 0; i < data.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < data.length) {
        sum += data[j];
        count++;
      }
    }
    result.push(sum / count);
  }
  return result;
}

// Naïve STL decomposition (trend via moving average, seasonal via period averaging)
function stlDecompose(
  data: number[],
  period: number,
  trendWindow: number = period * 2
): STLDecomposition {
  // Trend component
  const trend = movingAverage(data, trendWindow);

  // Detrended data
  const detrended = data.map((v, i) => v - trend[i]);

  // Seasonal component
  const seasonal = new Array(data.length).fill(0);
  for (let i = 0; i < period; i++) {
    // Collect all points belonging to the same season position
    const indices = [];
    for (let j = i; j < detrended.length; j += period) {
      indices.push(j);
    }
    const mean =
      indices.reduce((acc, idx) => acc + detrended[idx], 0) / indices.length;
    for (const idx of indices) {
      seasonal[idx] = mean;
    }
  }

  // Residual component
  const residual = data.map((v, i) => v - trend[i] - seasonal[i]);

  return { trend, seasonal, residual };
}

// Simple Kalman filter for 1‑D series (random walk model)
class SimpleKalmanFilter {
  private a: number; // state transition coefficient
  private q: number; // process variance
  private r: number; // measurement variance
  private x: number; // estimated state
  private p: number; // estimated error covariance

  constructor(
    initialState: number,
    initialErrorCovariance: number,
    processVariance: number,
    measurementVariance: number,
    stateTransition: number = 1
  ) {
    this.x = initialState;
    this.p = initialErrorCovariance;
    this.q = processVariance;
    this.r = measurementVariance;
    this.a = stateTransition;
  }

  // Predict step
  predict(): void {
    this.x = this.a * this.x;
    this.p = this.a * this.p * this.a + this.q;
  }

  // Update step with measurement z
  update(z: number): void {
    const k = this.p / (this.p + this.r); // Kalman gain
    this.x = this.x + k * (z - this.x);
    this.p = (1 - k) * this.p;
  }

  // Get current state estimate
  getState(): number {
    return this.x;
  }

  // Get current error variance
  getErrorVariance(): number {
    return this.p;
  }
}

// Forecast residuals using Kalman filter (random walk)
function kalmanForecastResiduals(
  residuals: number[],
  horizon: number
): number[] {
  if (residuals.length === 0) return new Array(horizon).fill(0);

  const initialState = residuals[residuals.length - 1];
  const filter = new SimpleKalmanFilter(
    initialState,
    1, // initial error covariance
    1e-5, // process variance (small)
    0.01 // measurement variance
  );

  // Run filter over existing residuals to adapt state
  for (const z of residuals) {
    filter.predict();
    filter.update(z);
  }

  // Forecast future residuals (prediction only, no measurement)
  const forecasts: number[] = [];
  for (let i = 0; i < horizon; i++) {
    filter.predict();
    forecasts.push(filter.getState());
  }
  return forecasts;
}

// Combine components to produce final forecast
function composeForecast(
  decomposition: STLDecomposition,
  residualForecast: number[],
  horizon: number
): number[] {
  const { trend, seasonal } = decomposition;
  const lastTrend = trend[trend.length - 1];
  const lastSeasonal = seasonal[seasonal.length - 1];
  const period = seasonal.length / Math.round(seasonal.length / DEFAULT_SEASONAL_PERIOD);

  // Extend trend with simple linear extrapolation (last difference)
  const trendDiff =
    trend.length >= 2
      ? trend[trend.length - 1] - trend[trend.length - 2]
      : 0;
  const trendForecast = [];
  for (let i = 0; i < horizon; i