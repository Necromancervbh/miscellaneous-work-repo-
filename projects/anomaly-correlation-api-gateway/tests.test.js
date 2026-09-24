import { describe, it, expect } from 'vitest';
import { computeAnomalyCorrelation } from './apiGateway';

describe('computeAnomalyCorrelation', () => {
  // Normal input
  it('should return a correlation coefficient for typical positive numbers', () => {
    const observed = [1, 2, 3, 4, 5];
    const expected = [2, 4, 6, 8, 10];
    const result = computeAnomalyCorrelation(observed, expected);
    expect(typeof result).toBe('number');
    // Perfect positive correlation should be close to 1
    expect(result).toBeCloseTo(1, 5);
  });

  it('should return a correlation coefficient for mixed positive and negative numbers', () => {
    const observed = [-5, -2, 0, 2, 5];
    const expected = [5, 2, 0, -2, -5];
    const result = computeAnomalyCorrelation(observed, expected);
    expect(typeof result).toBe('number');
    // Perfect negative correlation should be close to -1
    expect(result).toBeCloseTo(-1, 5);
  });

  // Edge cases
  it('should handle empty arrays by returning NaN or throwing', () => {
    const observed: number[] = [];
    const expected: number[] = [];
    expect(() => computeAnomalyCorrelation(observed, expected)).toThrow();
  });

  it('should handle arrays containing only zeros', () => {
    const observed = [0, 0, 0, 0];
    const expected = [0, 0, 0, 0];
    const result = computeAnomalyCorrelation(observed, expected);
    // Correlation is undefined when variance is zero; implementation may return NaN
    expect(Number.isNaN(result)).toBe(true);
  });

  it('should throw when either argument is null', () => {
    // @ts-ignore
    expect(() => computeAnomalyCorrelation(null, [1, 2, 3])).toThrow();
    // @ts-ignore
    expect(() => computeAnomalyCorrelation([1, 2, 3], null)).toThrow();
  });

  it('should correctly compute correlation with negative numbers', () => {
    const observed = [-10, -5, 0, 5, 10];
    const expected = [10, 5, 0, -5, -10];
    const