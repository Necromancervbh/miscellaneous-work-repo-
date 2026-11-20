import { describe, it, expect } from 'vitest';
import { calculateAnomalyCorrelation } from '../explainability_service';

// Helper to generate a range of numbers
const range = (n, start = 0) => Array.from({ length: n }, (_, i) => start + i);

describe('Anomaly Correlation Explainability Service', () => {
  // Normal input
  it('should correctly compute correlation for typical input', () => {
    const actual = [1, 2, 3, 4, 5];
    const predicted = [1.1, 1.9, 3.2, 3.8, 5.1];
    const result = calculateAnomalyCorrelation(actual, predicted);
    // Expected correlation is close to 1 (perfect positive linear relationship)
    expect(result).toBeCloseTo(0.99, 2);
  });

  // Edge case: empty arrays
  it('should throw an error when both input arrays are empty', () => {
    const actual = [];
    const predicted = [];
    expect(() => calculateAnomalyCorrelation(actual, predicted)).toThrow(
      /input arrays must not be empty/i
    );
  });

  // Edge case: zero-length one side
  it('should throw an error when one of the input arrays is empty', () => {
    const actual = [1, 2, 3];
    const predicted = [];
    expect(() => calculateAnomalyCorrelation(actual, predicted)).toThrow(
      /input arrays must not be empty/i
    );
  });

  // Edge case: null inputs
  it('should throw an error when inputs are null', () => {
    expect(() => calculateAnomalyCorrelation(null, null)).toThrow(
      /invalid input/i
    );
  });

  // Edge case: undefined inputs
  it('should throw an error when inputs are undefined', () => {
    expect(() => calculateAnomalyCorrelation(undefined, undefined)).toThrow(
      /invalid input/i
    );
  });

  // Edge case: mismatched lengths
  it('should throw an error when input arrays have different lengths', () => {
    const actual = [1, 2, 3];
    const predicted = [1, 2];
    expect(() => calculateAnomalyCorrelation(actual, predicted)).toThrow(
      /must have the same length/i
    );
  });

  // Edge case: negative numbers
  it('should correctly handle negative numbers', () => {
    const actual = [-5, -3, -1, 0, 2];
    const predicted = [-4.8, -3.2, -0.9, 0.1, 2.2];
    const result = calculateAnomalyCorrelation(actual, predicted);
    expect(result).toBeGreaterThan(0.9);
  });

  // Edge case: zero variance in actual values
  it('should return NaN or throw when actual values have zero variance', () => {
    const actual = [5, 5, 5, 5];
    const predicted = [1, 2, 3, 4];
    const result = calculateAnomalyCorrelation(actual, predicted);
    expect(Number.isNaN(result) || result === null).toBe(true);
  });

  // Boundary condition: perfect positive correlation
  it('should return