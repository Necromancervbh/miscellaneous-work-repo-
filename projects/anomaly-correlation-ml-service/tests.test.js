import { describe, it, expect } from 'vitest';
import {
  calculateAnomalyCorrelation,
  normalizeData,
  trainAnomalyModel,
  predictAnomalyScore,
} from './mlPipeline';

describe('Anomaly Correlation ML Service - calculateAnomalyCorrelation', () => {
  it('should return correct correlation for normal input', () => {
    const input = [1, 2, 3, 4, 5];
    const baseline = [2, 4, 6, 8, 10];
    const result = calculateAnomalyCorrelation(input, baseline);
    // Perfect positive linear relationship => correlation 1
    expect(result).toBeCloseTo(1, 5);
  });

  it('should handle negative correlation correctly', () => {
    const input = [1, 2, 3, 4, 5];
    const baseline = [10, 8, 6, 4, 2];
    const result = calculateAnomalyCorrelation(input, baseline);
    expect(result).toBeCloseTo(-1, 5);
  });

  it('should return 0 for uncorrelated data', () => {
    const input = [1, 2, 3, 4, 5];
    const baseline = [7, 7, 7, 7, 7];
    const result = calculateAnomalyCorrelation(input, baseline);
    expect(result).toBeCloseTo(0, 5);
  });

  it('should return NaN when both arrays are empty', () => {
    const result = calculateAnomalyCorrelation([], []);
    expect(Number.isNaN(result)).toBe(true);
  });

  it('should return NaN when one array is empty', () => {
    const result = calculateAnomalyCorrelation([1, 2, 3], []);
    expect(Number.isNaN(result)).toBe(true);
  });

  it('should handle arrays containing zeros', () => {
    const input = [0, 0, 0, 0, 0];
    const baseline = [1, 2, 3, 4, 5];
    const result = calculateAnomalyCorrelation(input, baseline);
    expect(Number.isNaN(result)).toBe(true);
  });

  it('should handle null values gracefully (treated as NaN)', () => {
    // @ts-ignore – intentionally passing null to test robustness
    const input = [1, null, 3, 4, 5];
    // @ts-ignore
    const baseline = [2, 4, 6, 8, 10];
    const result = calculateAnomalyCorrelation(input, baseline);
    expect(Number.isNaN(result)).toBe(true);
  });

  it('should correctly compute correlation with negative numbers', () => {
    const input = [-5, -4, -3, -2, -1];
    const baseline = [-10, -8, -6, -4, -2];
    const result = calculateAnomalyCorrelation(input, baseline);
    expect(result).toBeCloseTo(1, 5);
  });

  it('should handle mixed positive and negative numbers', () => {
    const input = [-2, -1, 0, 1, 2];
    const baseline = [2, 1, 0, -1, -2];
    const result = calculateAnomalyCorrelation(input, baseline);
    expect(result).toBeCloseTo(-1, 5);
  });

  it('should work with boundary length of 1 (returns NaN)', () => {
    const result = calculateAnomalyCorrelation([42], [24]);
    expect(Number.isNaN(result)).toBe(true);
  });

  it