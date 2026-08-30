import { LinearInterpolation, MovingAverage } from '../utils/statisticalUtils.js';

/**
 * @typedef {Object} AnomalyDetectionOptions
 * @property {number} [windowSize=10] - Size of the moving average window for trend estimation
 * @property {number} [zThreshold=2.5] - Z-score threshold for marking an anomaly
 * @property {boolean} [detectTrends=true] - Whether to subtract trend via moving average
 */

/**
 * Time Series Anomaly Detection Module.
 * Uses a simplified Seasonal-Trend decomposition and Z-score thresholding
 * to identify outliers in sequential data.
 */
class AnomalyDetector {
  /**
   * @param {number[]} data - Array of numeric time-series values.
   * @param {AnomalyDetectionOptions} options - Configuration for the detector.
   */
  constructor(data, options = {}) {
    if (!Array.isArray(data) || data.length < options.windowSize || data.some(v => typeof v !== 'number')) {
      throw new Error('Data must be a non-empty array of numbers with enough length for windowSize.');
    }
    this.data = data;
    this.options = {
      windowSize: 10,
      zThreshold: 2.5,
      detectTrends: true,
      ...options
    };
    this.preprocess();
  }

  /**
   * Pre-processes data to calculate residual, mean, and standard deviation.
   * @private
   */
  preprocess() {
    const { data, options } = this;
    this.residuals = [];
    
    if (options.detectTrends) {
      // Simple moving average for trend
      this.trend = MovingAverage.calculate(data, options.windowSize);
      // Residual = Actual - Trend
      for (let i = 0; i < data.length; i++) {
        // For edges, we use the nearest available trend value or linear interpolation
        this.residuals.push(data[i] - this.trend[i]);
      }
    } else {
      this.residuals = [...data];
    }

    this.mean = statistics.mean(this.residuals);
    this.stdDev = statistics.std(this.residuals, this.mean);
  }

  /**
   * Detects anomalies in the time series.
   * @returns {Array<{index: number, value: number, zScore: number, isAnomaly: boolean}>} Results of the detection process.
   */
  detect() {
    if (this.stdDev === 0) return this.data.map((v, i) => ({ index: i, value: v, zScore: 0, isAnomaly: false }));

    const results = this.residuals.map((res, i) => {
      const zScore = Math.abs(res - this.mean) / this.stdDev;
      return {
        index: i,
        value: this.data[i],
        zScore: zScore.toFixed(4),
        isAnomaly: zScore > this.options.zThreshold
      };
    });

    return results;
  }

  /**
   * Summary of the detection, including count of anomalies.
   * @returns {Object} Summary object.
   */
  getSummary() {
    const detections = this.detect();
    return {
      totalPoints: detections.length,
      anomaliesCount: detections.filter(d => d.isAnomaly).length,
      averageZScore: statistics.mean(detections.map(d => parseFloat(d.zScore))).toFixed(4),
      maxZScore: Math.max(...detections.map(d => parseFloat(d.zScore))).toFixed(4)
    };
  }
}

// Local Statistical helpers to avoid circular dependencies or external imports
class statistics {
  static mean(arr) {
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  static std(arr, mean) {
    if (arr.length === 0) return 0;
    const variance = arr.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / (arr.length - 1);
    return Math.sqrt(variance);
  }
}

class MovingAverage {
  static calculate(data, windowSize) {
    const result = new Array(data.length).fill(0);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += data[i];
      if (i >= windowSize) {
        sum -= data[i - windowSize];
      }
      const currentWindowItems = Math.min(i + 1, windowSize);
      result[i] = sum / currentWindowItems;
    }
    return result;
  }
}

export { AnomalyDetector };
