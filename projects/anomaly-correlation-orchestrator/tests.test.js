import { describe, it, expect } from 'vitest';
import { computeCorrelation } from './orchestrator';

describe('computeCorrelation - Anomaly Correlation Orchestrator', () => {
  // Normal input cases
  it('should return 1 for perfectly positively correlated data', () => {
    const observed = [1, 2, 3, 4, 5];
    const predicted = [1, 2, 3, 4, 5];
    const result = computeCorrelation(observed, predicted);
    expect(result).toBeCloseTo(1);
  });

  it('should return -1 for perfectly negatively correlated data', () => {
    const observed = [1, 2, 3, 4, 5];
    const predicted = [5, 4, 3, 2, 1];
    const result = computeCorrelation(observed, predicted);
    expect(result).toBeCloseTo(-1);
  });

  it('should return 0 for uncorrelated data', () => {
    const observed = [1, 2, 3, 4, 5];
    const predicted = [2, 2, 2, 2, 2];
    const result = computeCorrelation(observed, predicted);
    expect(result).toBeCloseTo(0);
  });

  // Edge cases
  it('should throw an error when both arrays are empty', () => {
    const observed: number[] = [];
    const predicted: number[] = [];
    expect(() => computeCorrelation(observed, predicted)).toThrow();
  });

  it('should throw an error when one array is empty', () => {
    const observed = [1, 2, 3];
    const predicted: number[] = [];
    expect(() => computeCorrelation(observed, predicted)).toThrow();
  });

  it('should return NaN when all values are zero (zero variance)', () => {
    const observed = [0, 0, 0, 0];
    const predicted = [0, 0, 0, 0];
    const result = computeCorrelation(observed, predicted);
    expect(result).toBeNaN();
  });

  it('should throw an error when inputs contain null values', () => {
    // @ts-ignore – intentionally passing null to test runtime behavior
    const observed = [1, null, 3];
    // @ts-ignore
    const predicted = [1, 2, 3];
    expect(() => computeCorrelation(observed, predicted)).toThrow();
  });

  it('should correctly handle negative numbers', () => {
    const observed = [-5, -