import { describe, it, expect } from 'vitest';
import { calculateAnomalyCorrelation } from '../analyticsEngine';

describe('calculateAnomalyCorrelation', () => {
  // Normal input
  it('should return a high positive correlation for closely matching data sets', () => {
    const actual = [1, 2, 3, 4, 5];
    const predicted = [1.1, 1.9, 3.2, 3.9, 5.1];
    const result = calculateAnomalyCorrelation(actual, predicted);
    expect(result).toBeCloseTo(0.99, 2);
  });

  // Edge case: empty arrays
  it('should return NaN when both input arrays are empty', () => {
    const actual: number[] = [];
    const predicted: number[] = [];
    const result = calculateAnomalyCorrelation(actual, predicted);
    expect(Number.isNaN(result)).toBe(true);
  });

  // Edge case: arrays containing only zeros
  it('should return NaN when arrays contain only zero values', () => {
    const actual = [0, 0, 0, 0];
    const predicted = [0, 0, 0, 0];
    const result = calculateAnomalyCorrelation(actual, predicted);
    expect(Number.isNaN(result)).toBe(true);
  });

  // Edge case: null values in input
  it('should throw an error when input contains null values', () => {
    const actual = [1, null as any, 3];
    const predicted = [1, 2, 3];
    expect(() => calculateAnomalyCorrelation(actual, predicted)).toThrow();
  });

  // Edge case: negative numbers
  it('should correctly compute correlation with negative numbers', () => {
    const actual = [-5, -3, -1, 0, 2];
    const predicted = [-4.8, -2.9, 0.2, 0.1, 2.1];
    const result = calculateAnomalyCorrelation(actual, predicted);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeCloseTo(0.96, 2);
  });

  //