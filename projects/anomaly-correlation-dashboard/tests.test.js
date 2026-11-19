import { describe, it, expect } from 'vitest';
import {
  calculateAnomalyCorrelation,
  getAnomalyScore,
  generateDashboardMetrics,
} from '../dashboard_service';

// Helper to generate a simple dataset
const createDataset = (values) => values.map((v, i) => ({ timestamp: i, value: v }));

describe('calculateAnomalyCorrelation', () => {
  it('should return a correlation coefficient for normal input', () => {
    const actual = createDataset([1, 2, 3, 4, 5]);
    const predicted = createDataset([1.1, 1.9, 3.2, 3.8, 5.1]);
    const result = calculateAnomalyCorrelation(actual, predicted);
    // Correlation should be close to 1 for near‑perfect linear relationship
    expect(result).toBeGreaterThanOrEqual(0.95);
    expect(result).toBeLessThanOrEqual(1);
  });

  it('should handle empty datasets gracefully', () => {
    const result = calculateAnomalyCorrelation([], []);
    // Define expected behaviour – here we assume NaN is returned for no data
    expect(result).toBeNaN();
  });

  it('should treat zero values correctly', () => {
    const actual = createDataset([0, 0, 0, 0, 0]);
    const predicted = createDataset([0, 0, 0, 0, 0]);
    const result = calculateAnomalyCorrelation(actual, predicted);
    // Zero variance leads to NaN correlation
    expect(result).toBeNaN();
  });

  it('should handle null or undefined entries by ignoring them', () => {
    const actual = createDataset([1, null, 3, undefined, 5]);
    const predicted = createDataset([1, 2, 3, 4, 5]);
    const result = calculateAnomalyCorrelation(actual, predicted);
    // After filtering, correlation should be perfect
    expect(result).toBeCloseTo(1);
  });

  it('should correctly compute correlation with negative numbers', () => {
    const actual = createDataset([-5, -4, -3, -2, -1]);
    const predicted = createDataset([-5.1, -3.9, -3.2, -2.1, -0.9]);
    const result = calculateAnomalyCorrelation(actual, predicted);
    expect(result).toBeGreaterThanOrEqual(0.95);
  });

  it('should handle boundary numeric values (max safe integer)', () => {
    const max = Number.MAX_SAFE_INTEGER;
    const actual = createDataset([max, max - 1, max - 2]);
    const predicted = createDataset([max, max - 1, max - 2]);
    const result = calculateAnomalyCorrelation(actual, predicted);
    expect(result).toBeCloseTo(1);
  });
});

describe('getAn