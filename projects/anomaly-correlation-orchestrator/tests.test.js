import { describe, it, expect } from 'vitest';
import { correlateAnomalies } from '../orchestrator';

describe('Anomaly Correlation Orchestrator - correlateAnomalies', () => {
  // Normal input tests
  it('should correctly calculate correlation for a typical dataset', () => {
    const data = [
      { actual: 10, predicted: 12 },
      { actual: 15, predicted: 14 },
      { actual: 20, predicted: 19 },
      { actual: 25, predicted: 27 },
    ];
    const result = correlateAnomalies(data);
    // Assuming the function returns a number between -1 and 1
    expect(result).toBeTypeOf('number');
    expect(result).toBeGreaterThanOrEqual(-1);
    expect(result).toBeLessThanOrEqual(1);
  });

  it('should return 1 for perfectly positively correlated data', () => {
    const data = [
      { actual: 1, predicted: 2 },
      { actual: 2, predicted: 4 },
      { actual: 3, predicted: 6 },
      { actual: 4, predicted: 8 },
    ];
    const result = correlateAnomalies(data);
    expect(result).toBeCloseTo(1, 5);
  });

  it('should return -1 for perfectly negatively correlated data', () => {
    const data = [
      { actual: 1, predicted: 8 },
      { actual: 2, predicted: 6 },
      { actual: 3, predicted: 4 },
      { actual: 4, predicted: 2 },
    ];
    const result = correlateAnomalies(data);
    expect(result).toBeCloseTo(-1, 5);
  });

  // Edge case: empty input
  it('should return null or NaN for empty dataset', () => {
    const data = [];
    const result = correlateAnomalies(data);
    expect(result).toBeNull();
  });

  // Edge case: single element
  it('should return null or NaN for a single data point', () => {
    const data = [{ actual: 5, predicted: 5 }];
    const result = correlateAnomalies(data);
    expect(result).toBeNull();
  });

  // Edge case: zero values
  it('should handle zero values correctly', () => {
    const data = [
      { actual: 0, predicted: 0 },
      { actual: 0, predicted: 5 },
      { actual: 5, predicted: 0 },
      { actual: 5, predicted: 5 },
    ];
    const result = correlateAnomalies(data);
    expect(result).toBeTypeOf('number');
    expect(result).toBeGreaterThanOrEqual(-1);
    expect(result).toBeLessThanOrEqual(1);
  });

  // Edge case: null values inside dataset
  it('should throw an error when dataset contains null entries', () => {
    const data = [
      { actual: 10, predicted: 12 },
      null,
      { actual: 20, predicted: 19 },
    ];
    expect(() => correlateAnomalies(data)).toThrowError();
  });

  // Edge case: undefined values
  it('should throw an error when dataset contains undefined entries', () => {
    const data = [
      { actual: 10, predicted: 12 },
      undefined,
      { actual: 20, predicted: 19 },
    ];
    expect(() => correlateAnomalies(data)).