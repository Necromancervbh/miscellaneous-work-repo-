import { AsyncIterable } from "ix";
import DBSCAN from "density-clustering";
import * as tf from "@tensorflow/tfjs-node";

/**
 * Represents a single time‑series data point.
 */
export interface TimeSeriesPoint {
    /** Unix timestamp in milliseconds */
    timestamp: number;
    /** Observed value */
    value: number;
}

/**
 * Simple scalar Kalman filter for smoothing a 1‑D time series.
 *
 * Predict step:
 *   x̂⁻ₖ = A * x̂ₖ₋₁                     (A = 1)
 *   P⁻ₖ = A * Pₖ₋₁ * Aᵀ + Q              (Q = process noise covariance)
 *
 * Update step:
 *   Kₖ = P⁻ₖ * Hᵀ / (H * P⁻ₖ * Hᵀ + R)    (H = 1, R = measurement noise covariance)
 *   x̂ₖ = x̂⁻ₖ + Kₖ * (zₖ - H * x̂⁻ₖ)
 *   Pₖ = (1 - Kₖ * H) * P⁻ₖ
 */
export class KalmanFilter {
    private state: number;          // x̂ₖ (estimated value)
    private covariance: number;     // Pₖ (estimated error covariance)
    private readonly processNoise: number;   // Q
    private readonly measurementNoise: number; // R

    /**
     * @param initialState Initial estimate of the state (e.g., first observation)
     * @param initialCovariance Initial error covariance (positive number)
     * @param processNoise Process noise covariance Q (>=0)
     * @param measurementNoise Measurement noise covariance R (>=0)
     */
    constructor(
        initialState: number,
        initialCovariance: number,
        processNoise: number,
        measurementNoise: number
    ) {
        if (!isFinite(initialState) || !isFinite(initialCovariance) ||
            !isFinite(processNoise) || !isFinite(measurementNoise)) {
            throw new Error("KalmanFilter parameters must be finite numbers.");
        }
        if (initialCovariance <= 0 || processNoise < 0 || measurementNoise <= 0) {
            throw new Error("Covariance values must be positive (processNoise may be zero).");
        }
        this.state = initialState;
        this.covariance = initialCovariance;
        this.processNoise = processNoise;
        this.measurementNoise = measurementNoise;
    }

    /**
     * Filters a series of observations.
     * @param observations Array of numeric observations.
     * @returns Object containing smoothed values and residuals.
     */
    public filter(observations: number[]): { smoothed: number[]; residuals: number[] } {
        if (!Array.isArray(observations) || observations.length === 0) {
            throw new Error("Observations must be a non‑empty array of numbers.");
        }

        const smoothed: number[] = [];
        const residuals: number[] = [];

        for (const z of observations) {
            if (!isFinite(z)) {
                throw new Error("All observations must be finite numbers.");
            }

            // Predict
            const predictedState = this.state; // A = 1, no control input
            const predictedCov = this.covariance + this.processNoise; // P⁻ₖ

            // Update
            const kalmanGain = predictedCov / (predictedCov + this.measurementNoise);
            const innovation = z - predictedState; // (zₖ - H * x̂⁻ₖ), H = 1
            this.state = predictedState + kalmanGain * innovation;
            this.covariance = (1 - kalmanGain) * predictedCov;

            smoothed.push(this.state);
            residuals.push(innovation);
        }

        return { smoothed, residuals };
    }
}

/**
 * Applies Kalman smoothing to a time‑series and returns residuals.
 * @param series Array of TimeSeriesPoint ordered by timestamp.
 * @param options Optional Kalman filter parameters.
 */
export function applyKalmanFilter(
    series: TimeSeriesPoint[],
    options?: {
        initialCovariance?: number;
        processNoise?: number;
        measurementNoise?: number;
    }
): { smoothed: number[]; residuals: number[] } {
    if (!Array.isArray(series) || series.length === 0) {
        throw new Error("Series must be a non‑empty array of TimeSeriesPoint.");
    }

    // Validate monotonic timestamps and numeric values
    for (let i = 0; i < series.length; i++) {
        const pt = series[i];
        if (!Number.isFinite(pt.timestamp) || !Number.isFinite(pt.value)) {
            throw new Error(`Invalid point at index ${i}: timestamps and values must be finite numbers.`);
        }
        if (i > 0 && pt.timestamp <= series[i - 1].timestamp) {
            throw new Error(`Timestamps must be strictly increasing. Violation at index ${i}.`);
        }
    }

    const values = series.map(p => p.value);
    const {
        initialCovariance = 1,
        processNoise = 1e-3,
        measurementNoise = 1e-2,
    } = options ?? {};

    const kf = new KalmanFilter(
        values[0],
        initialCovariance,
        processNoise,
        measurementNoise
    );

    return kf.filter(values);
}

/**
 * Runs DBSCAN on residuals to find clusters of normal behavior.
 * Points not belonging to any cluster are considered anomalies.
 *
 * @param residuals Array of residual values (1‑D).
 * @param eps Neighborhood radius.
 * @param minPts Minimum points to form a dense region.
 * @returns Object containing indices of anomalies and cluster assignments.
 */
export function detectAnomaliesDBSCAN(
    residuals: number[],
    eps: number = 0.5,
    minPts: number = 5
): { anomalies: number[]; clusters: number[][] } {
    if (!Array.isArray(residuals) || residuals.length === 0) {
        throw new Error("Residuals must be a non‑empty array of numbers.");
    }
    if (eps <= 0) {
        throw new Error("eps must be a