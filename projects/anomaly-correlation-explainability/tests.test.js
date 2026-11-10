import { describe, it, expect } from 'vitest';
import { calculateAnomalyCorrelation } from '../explainability_engine';

describe('calculateAnomalyCorrelation', () => {
  // Normal input
  it('should return a correlation close to 1 for perfectly positively correlated data', () => {
    const observed = [1, 2, 3, 4, 5];
    const predicted = [2, 4, 6, 8, 10];
    const result = calculateAnomalyCorrelation(observed, predicted);
    expect(result).toBeCloseTo(1, 5);
  });

  it('should return a correlation close to -1 for perfectly negatively correlated data', () => {
    const observed = [1, 2, 3, 4, 5];
    const predicted = [10, 8, 6, 4, 2];
    const result = calculateAnomalyCorrelation(observed, predicted);
    expect(result).toBeCloseTo(-1, 5);
  });

  it('should return a correlation near 0 for uncorrelated data', () => {
    const observed = [1, 2, 3, 4, 5];
    const predicted = [5, 3, 1, 4, 2];
    const result = calculateAnomalyCorrelation(observed, predicted);
    expect(result).toBeCloseTo(0, 1);
  });

  // Edge cases
  it('should handle empty input arrays by returning null', () => {
    const result = calculateAnomalyCorrelation([], []);
    expect(result).toBeNull();
  });

  it('should handle arrays containing zeros correctly', () => {
    const observed = [0, 0, 0, 0, 0];
    const predicted = [0, 0, 0, 0, 0];
    const result = calculateAnomalyCorrelation(observed, predicted);
    // Zero variance leads to undefined correlation; service returns null
    expect(result).toBeNull();
  });

  it('should handle null inputs by throwing a TypeError', () => {
    // @ts-ignore – intentionally passing null to test error handling
    expect(() => calculateAnomalyCorrelation(null, null)).toThrow(TypeError);
  });

  it('should handle negative numbers correctly', () => {
    const observed = [-5, -4, -3, -2, -1];
    const predicted = [-10, -8, -6, -4, -2];
    const result = calculateAnomalyCorrelation(observed, predicted);
    expect(result).toBeCloseTo(1, 5);
  });

  // Boundary conditions
  it('should return 1 when both arrays are identical (perfect positive correlation)', () => {
    const data = [3, 1, 4, 1, 5, 9];
    const result = calculateAnomalyCorrelation(data, data);
    expect(result).toBeCloseTo(1, 5);
  });

  it('should return -1 when one array is the negative of the other (perfect negative correlation)', () => {
    const observed = [1, 2, 3, 4, 5];
    const predicted = observed.map(v => -v);
    const result = calculateAnomalyCorrelation(observed, predicted);
    expect(result).toBeClose