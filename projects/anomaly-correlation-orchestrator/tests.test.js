import { describe, it, expect } from 'vitest';
import { correlateAnomalies } from '../orchestrator_service';

// Helper to generate a range of numbers
const range = (start, end, step = 1) => {
  const arr = [];
  for (let i = start; i <= end; i += step) arr.push(i);
  return arr;
};

describe('Anomaly Correlation Orchestrator - correlateAnomalies', () => {
  // Normal input
  it('should correctly calculate correlation for a typical positive dataset', () => {
    const dataX = [1, 2, 3, 4, 5];
    const dataY = [2, 4, 6, 8, 10];
    const result = correlateAnomalies(dataX, dataY);
    // Perfect positive correlation should be 1
    expect(result).toBeCloseTo(1, 5);
  });

  it('should correctly calculate correlation for a typical negative dataset', () => {
    const dataX = [1, 2, 3, 4, 5];
    const dataY = [10, 8, 6, 4, 2];
    const result = correlateAnomalies(dataX, dataY);
    // Perfect negative correlation should be -1
    expect(result).toBeCloseTo(-1, 5);
  });

  // Edge cases
  it('should return NaN when both input arrays are empty', () => {
    const result = correlateAnomalies([], []);
    expect(result).toBeNaN();
  });

  it('should return NaN when one of the input arrays is empty', () => {
    const result = correlateAnomalies([1, 2, 3], []);
    expect(result).toBeNaN();
  });

  it('should handle zero values correctly', () => {
    const dataX = [0, 0, 0, 0];
    const dataY = [0, 0, 0, 0];
    const result = correlateAnomalies(dataX, dataY);
    // Correlation is undefined when variance is zero; expect NaN
    expect(result).toBeNaN();
  });

  it('should throw a TypeError when inputs are null', () => {
    // @ts-ignore – intentionally passing null to test error handling
    expect(() => correlateAnomalies(null, null)).toThrow(TypeError);
  });

  it('should correctly handle negative numbers', () => {
    const dataX = [-5, -4, -3, -2, -1];
    const dataY = [-10, -8, -6, -4, -2];
    const result = correlateAnomalies(dataX, dataY);
    expect(result).toBeCloseTo(1, 5);
  });

  // Boundary conditions
  it('should handle the maximum safe integer values without overflow', () => {
    const max = Number.MAX_SAFE_INTEGER;
    const