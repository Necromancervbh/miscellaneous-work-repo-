import { describe, it, expect } from 'vitest';
import { computeAnomalyCorrelation } from './aggregatorService';

describe('computeAnomalyCorrelation', () => {
  // Normal input cases
  it('should return 1 for perfectly positively correlated series', () => {
    const seriesA = [1, 2, 3, 4, 5];
    const seriesB = [2, 4, 6, 8, 10];
    const result = computeAnomalyCorrelation(seriesA, seriesB);
    expect(result).toBeCloseTo(1, 5);
  });

  it('should return -1 for perfectly negatively correlated series', () => {
    const seriesA = [1, 2, 3, 4, 5];
    const seriesB = [10, 8, 6, 4, 2];
    const result = computeAnomalyCorrelation(seriesA, seriesB);
    expect(result).toBeCloseTo(-1, 5);
  });

  it('should return 0 for uncorrelated series', () => {
    const seriesA = [1, 2, 3, 4, 5];
    const seriesB = [7, 7, 7, 7, 7];
    const result = computeAnomalyCorrelation(seriesA, seriesB);
    expect(result).toBeCloseTo(0, 5);
  });

  // Edge cases
  it('should handle empty arrays by returning NaN', () => {
    const seriesA: number[] = [];
    const seriesB: number[] = [];
    const result = computeAnomalyCorrelation(seriesA, seriesB);
    expect(result).toBeNaN();
  });

  it('should handle arrays containing zeros correctly', () => {
    const seriesA = [0, 0, 0, 0];
    const seriesB = [0, 0, 0, 0];
    const result = computeAnomalyCorrelation(seriesA, seriesB);
    expect(result).toBeNaN(); // variance is zero, correlation undefined
  });

  it('should throw when either input is null', () => {
    // @ts-ignore: intentional misuse for test
    expect(() => computeAnomalyCorrelation(null, [1, 2, 3])).toThrow();
    // @ts-ignore: intentional misuse for test
    expect(() => computeAnomalyCorrelation([1, 2, 3], null)).toThrow();
  });

  it('should correctly compute correlation with negative numbers', () => {
    const seriesA = [-1, -2, -3,