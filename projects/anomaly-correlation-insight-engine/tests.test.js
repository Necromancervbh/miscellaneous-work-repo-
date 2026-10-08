import { describe, it, expect } from 'vitest';
import { computeAnomalyCorrelation } from '../insightEngine';

describe('computeAnomalyCorrelation', () => {
  // Normal input
  it('should return a correlation coefficient between -1 and 1 for typical data sets', () => {
    const data = [
      { value: 10, anomalyScore: 0.2 },
      { value: 20, anomalyScore: 0.4 },
      { value: 30, anomalyScore: 0.6 },
      { value: 40, anomalyScore: 0.8 },
      { value: 50, anomalyScore: 1.0 },
    ];
    const result = computeAnomalyCorrelation(data);
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(-1);
    expect(result).toBeLessThanOrEqual(1);
  });

  // Edge case: empty array
  it('should return null when given an empty array', () => {
    const result = computeAnomalyCorrelation([]);
    expect(result).toBeNull();
  });

  // Edge case: array with a single element (insufficient data)
  it('should return null when given a single data point', () => {
    const data = [{ value: 42, anomalyScore: 0.5 }];
    const result = computeAnomalyCorrelation(data);
    expect(result).toBeNull();
  });

  // Edge case: zero values
  it('should correctly handle data points with zero values', () => {
    const data = [
      { value: 0, anomalyScore: 0 },
      { value: 0, anomalyScore: 0 },
      { value: 0, anomalyScore: 0 },
    ];
    const result = computeAnomalyCorrelation(data);
    // Correlation is undefined for constant series; engine should return null
    expect(result).toBeNull();
  });

  // Edge case: null values in the dataset
  it('should throw a TypeError when data contains null entries', () => {
    const data = [
      { value: 10, anomalyScore: 0.2 },
      null,
      { value: 30, anomalyScore: 0.6 },
    ];
    expect(() => computeAnomalyCorrelation(data as any)).toThrow(TypeError);
  });

  // Edge case: negative numbers
  it('should correctly compute correlation when values include negatives', () => {
    const data = [
      { value: -10, anomalyScore: 0.9 },
      { value: -5, anomalyScore: 0.6 },
      { value: 0, anomalyScore: 0.3 },
      { value: 5, anomalyScore: 0.0 },
      { value: 10, anomalyScore: -0.