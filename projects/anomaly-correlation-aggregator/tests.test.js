import { describe, it, expect } from 'vitest';
import { aggregateAnomalyCorrelation } from './aggregator';

describe('aggregateAnomalyCorrelation', () => {
  // Normal input tests
  it('calculates correlation for perfectly positively correlated data', () => {
    const seriesA = [1, 2, 3, 4, 5];
    const seriesB = [2, 4, 6, 8, 10];
    const result = aggregateAnomalyCorrelation(seriesA, seriesB);
    expect(result).toBeCloseTo(1, 5);
  });

  it('calculates correlation for perfectly negatively correlated data', () => {
    const seriesA = [1, 2, 3, 4, 5];
    const seriesB = [10, 8, 6, 4, 2];
    const result = aggregateAnomalyCorrelation(seriesA, seriesB);
    expect(result).toBeCloseTo(-1, 5);
  });

  it('calculates correlation for uncorrelated data', () => {
    const seriesA = [1, 2, 3, 4, 5];
    const seriesB = [5, 3, 1, 4, 2];
    const result = aggregateAnomalyCorrelation(seriesA, seriesB);
    expect(result).toBeCloseTo(0, 1);
  });

  // Edge case tests
  it('returns 0 for empty input arrays', () => {
    const result = aggregateAnomalyCorrelation([], []);
    expect(result).toBe(0);
  });

  it('handles arrays containing zeros correctly', () => {
    const seriesA = [0, 0, 0, 0, 0];
    const seriesB = [0, 0, 0, 0, 0];
    const result = aggregateAnomalyCorrelation(seriesA, seriesB);
    expect(result).toBe(0);
  });

  it('throws an error when one of the inputs is null', () => {
    // @ts-ignore: intentional misuse for test
    expect(() => aggregateAnomalyCorrelation(null, [1, 2, 3])).toThrow();
    // @ts-ignore: intentional misuse for test
    expect(() => aggregateAnomalyCorrelation([1, 2, 3], null)).toThrow();
  });

  it('handles negative numbers correctly', () => {
    const seriesA = [-5, -4, -3, -2, -1];
    const seriesB = [-10, -8, -6, -4, -2];
    const result = aggregateAnomalyCorrelation(seriesA, seriesB);
    expect(result).toBeCloseTo(1, 5);
  });

  it('throws an error when array lengths differ', () => {
    const