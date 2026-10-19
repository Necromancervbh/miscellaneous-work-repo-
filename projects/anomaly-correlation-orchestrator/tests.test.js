import { describe, it, expect } from 'vitest';
import { computeCorrelation } from './orchestrator';

describe('Anomaly Correlation Orchestrator', () => {
  // Normal input
  it('should correctly compute correlation for typical positive datasets', () => {
    const x = [1, 2, 3, 4, 5];
    const y = [2, 4, 6, 8, 10];
    const result = computeCorrelation(x, y);
    // Perfect positive correlation
    expect(result).toBeCloseTo(1, 5);
  });

  it('should correctly compute correlation for typical negative correlation datasets', () => {
    const x = [1, 2, 3, 4, 5];
    const y = [10, 8, 6, 4, 2];
    const result = computeCorrelation(x, y);
    // Perfect negative correlation
    expect(result).toBeCloseTo(-1, 5);
  });

  it('should correctly compute correlation for mixed sign datasets', () => {
    const x = [-2, -1, 0, 1, 2];
    const y = [4, 1, 0, 1, 4];
    const result = computeCorrelation(x, y);
    // Symmetric quadratic relationship, correlation should be positive but less than 1
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(1);
  });

  // Edge cases
  it('should return NaN for empty input arrays', () => {
    const result = computeCorrelation([], []);
    expect(result).toBeNaN();
  });

  it('should return NaN when one of the arrays is empty', () => {
    const result = computeCorrelation([1, 2, 3], []);
    expect(result).toBeNaN();
  });

  it('should handle arrays containing zero values correctly', () => {
    const x = [0, 0, 0, 0, 0];
    const y = [1, 2, 3, 4, 5];
    const result = computeCorrelation(x, y);
    // Zero variance in x leads to NaN correlation
    expect(result).toBeNaN();
  });

  it('should throw TypeError when inputs are null', () => {
    // @ts-ignore – intentionally passing null to test runtime behavior
    expect(() => computeCorrelation(null, null)).toThrow(TypeError);
  });

  it('should throw TypeError when inputs contain null elements', () => {
    // @ts-ignore – intentionally passing null inside array
    const x = [1, null, 3];
    const y = [4, 5, 6];
    expect(() => computeCorrelation(x, y)).toThrow(TypeError);
  });

  it('should correctly compute correlation with negative numbers',