import { describe, it, expect } from 'vitest';
import { computeAnomalyCorrelation, generateDashboardMetrics } from './dashboardServer';

// Helper to create a matrix of numbers
const createMatrix = (rows, cols, filler) => {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, filler));
};

describe('computeAnomalyCorrelation', () => {
  it('should return correct correlation for normal input', () => {
    const data = [
      [1, 2, 3, 4],
      [2, 4, 6, 8],
      [5, 7, 9, 11],
    ];
    const result = computeAnomalyCorrelation(data);
    // Expected correlation for perfectly linear relationships is 1
    expect(result).toBeCloseTo(1, 5);
  });

  it('should handle empty input gracefully', () => {
    const data = [];
    const result = computeAnomalyCorrelation(data);
    expect(result).toBe(0);
  });

  it('should return 0 correlation when all values are zero', () => {
    const data = createMatrix(3, 4, () => 0);
    const result = computeAnomalyCorrelation(data);
    expect(result).toBe(0);
  });

  it('should throw when input is null', () => {
    // @ts-ignore – intentionally passing wrong type
    expect(() => computeAnomalyCorrelation(null)).toThrowError();
  });

  it('should correctly process negative numbers', () => {
    const data = [
      [-1, -2, -3],
      [-2, -4, -6],
      [1, 2, 3],
    ];
    const result = computeAnomalyCorrelation(data);
    // The first two rows are perfectly correlated (positive), third is inverse
    // Overall correlation should be close to 0 (mixed signs)
    expect(result).toBeCloseTo(0, 1);
  });

  it('should handle boundary condition with very large numbers', () => {
    const large = Number.MAX_SAFE_INTEGER;
    const data = [
      [large, large - 1, large - 2],
      [large - 3, large - 4, large - 5],
    ];
    const result = computeAnomalyCorrelation(data);
    // Correlation should still be computable and close to 1
    expect(result).toBeCloseTo(1, 5);
  });

  it('should return NaN when variance is zero (identical rows)', () => {
    const data = [
      [5, 5, 5],
      [5, 5, 5],
    ];
    const result = computeAnomalyCorrelation(data);
    expect(Number.isNaN(result)).toBe(true);
  });
});

describe('generateDashboardMetrics', () => {
  it('should produce metrics object for normal dataset', () => {
    const data = [
      [10, 20, 30],
      [15, 25, 35],
      [20, 30, 40],
    ];
    const metrics = generateDashboardMetrics(data);
    expect(metrics).toHaveProperty('correlation');
    expect(metrics).toHaveProperty('averageAnomaly');
    expect(metrics.correlation).toBeGreaterThanOrEqual(0);
    expect(metrics.correlation).toBeLessThanOrEqual(1);
    expect(metrics.averageAn