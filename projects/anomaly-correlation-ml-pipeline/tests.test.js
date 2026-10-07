import { describe, it, expect } from 'vitest';
import { computeAnomalyCorrelation } from './pipeline';

describe('computeAnomalyCorrelation', () => {
  // Normal input: perfect positive correlation
  it('should return 1 for identical positive sequences', () => {
    const observed = [1, 2, 3, 4, 5];
    const predicted = [1, 2, 3, 4, 5];
    const result = computeAnomalyCorrelation(observed, predicted);
    expect(result).toBeCloseTo(1, 5);
  });

  // Normal input: perfect negative correlation
  it('should return -1 for perfectly inversed sequences', () => {
    const observed = [1, 2, 3, 4, 5];
    const predicted = [5, 4, 3, 2, 1];
    const result = computeAnomalyCorrelation(observed, predicted);
    expect(result).toBeCloseTo(-1, 5);
  });

  // Edge case: empty arrays
  it('should return null for empty input arrays', () => {
    const observed: number[] = [];
    const predicted: number[] = [];
    const result = computeAnomalyCorrelation(observed, predicted);
    expect(result).toBeNull();
  });

  // Edge case: mismatched lengths
  it('should throw an error when input arrays have different lengths', () => {
    const observed = [1, 2, 3];
    const predicted = [1, 2];
    expect(() => computeAnomalyCorrelation(observed, predicted)).toThrow();
  });

  // Edge case: arrays containing zero values
  it('should correctly handle arrays with zero values', () => {
    const observed = [0, 0, 0, 0];
    const predicted = [0, 0, 0, 0];
    const result = computeAnomalyCorrelation(observed, predicted);
    // Correlation is undefined for constant series; implementation may return 0 or null
    expect([0, null]).toContain(result);
  });

  // Edge case: arrays containing null values
  it