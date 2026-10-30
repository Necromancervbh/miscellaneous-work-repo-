import { describe, it, expect } from 'vitest';
import { predictCorrelation } from './predictionEngine';

describe('Anomaly Correlation Prediction Engine', () => {
  // Normal input tests
  it('should return a correlation value between -1 and 1 for typical positive data', () => {
    const data = [10, 20, 30, 40, 50];
    const result = predictCorrelation(data);
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(-1);
    expect(result).toBeLessThanOrEqual(1);
  });

  it('should return a correlation value between -1 and 1 for mixed positive and negative data', () => {
    const data = [-5, 0, 5, 10, -10];
    const result = predictCorrelation(data);
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(-1);
    expect(result).toBeLessThanOrEqual(1);
  });

  // Edge case: empty array
  it('should throw an error when given an empty array', () => {
    expect(() => predictCorrelation([])).toThrow();
  });

  // Edge case: array with a single zero
  it('should handle an array containing only zero without throwing', () => {
    const data = [0, 0, 0, 0];
    const result = predictCorrelation(data);
    expect(typeof result).toBe('number');
    // Correlation of a constant series is undefined; implementation may return 0
    expect(result).toBeCloseTo(0, 5);
  });

  // Edge case: null input
  it('should throw an error when input is null', () => {
    // @ts-ignore – intentionally passing wrong type
    expect(() => predictCorrelation(null)).toThrow();
  });

  // Edge case: undefined input
  it('should throw an error when input is undefined', () => {
    // @ts-ignore – intentionally passing wrong type
    expect(() => predictCorrelation(undefined)).toThrow();
  });

  // Edge case: array containing null values
  it('should throw an error when array contains null values', () => {
    // @ts-ignore – intentionally passing wrong type inside array
    expect(() => predictCorrelation([1, null, 3])).toThrow();
  });

  // Edge case: negative numbers
  it('should correctly process an array of negative numbers', () => {
    const data = [-10, -20, -30, -40, -50];
    const result = predictCorrelation(data);
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(-1);
    expect(result).toBeLessThanOrEqual(1);
  });

  // Boundary condition: maximum safe integer values
  it('should handle large integer values without overflow', () => {
    const max = Number.MAX_SAFE_INTEGER;
    const data = [max, max - 1, max - 2, max - 3, max - 4];
    const result = predictCorrelation(data);
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(-1);
    expect(result).toBeLessThanOrEqual(1);
  });

  // Boundary condition: minimum safe integer values
  it('