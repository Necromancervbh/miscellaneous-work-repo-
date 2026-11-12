import { describe, it, expect } from 'vitest';
import { aggregateAnomalyCorrelation } from '../aggregator_service';

describe('Anomaly Correlation Aggregator', () => {
  // Normal input: perfectly positively correlated series
  it('calculates correlation of perfectly positively correlated series', () => {
    const seriesA = [1, 2, 3, 4, 5];
    const seriesB = [2, 4, 6, 8, 10];
    const result = aggregateAnomalyCorrelation(seriesA, seriesB);
    expect(result).toBeCloseTo(1, 5);
  });

  // Normal input: perfectly negatively correlated series
  it('calculates correlation of perfectly negatively correlated series', () => {
    const seriesA = [1, 2, 3, 4, 5];
    const seriesB = [10, 8, 6, 4, 2];
    const result = aggregateAnomalyCorrelation(seriesA, seriesB);
    expect(result).toBeCloseTo(-1, 5);
  });

  // Normal input: uncorrelated series
  it('calculates correlation of uncorrelated series', () => {
    const seriesA = [1, 2, 3, 4, 5];
    const seriesB = [5, 3, 1, 2, 4];
    const result = aggregateAnomalyCorrelation(seriesA, seriesB);
    expect(result).toBeCloseTo(0, 5);
  });

  // Edge case: empty arrays
  it('returns null for empty input arrays', () => {
    const seriesA = [];
    const seriesB = [];
    const result = aggregateAnomalyCorrelation(seriesA, seriesB);
    expect(result).toBeNull();
  });

  // Edge case: one empty array
  it('returns null when one of the input arrays is empty', () => {
    const seriesA = [1, 2, 3