import { describe, it, expect } from 'vitest';
import {
  calculateAnomalyCorrelation,
  generateDashboardMetrics,
  normalizeData,
} from './dashboardServer';

describe('calculateAnomalyCorrelation', () => {
  it('should return 1 for perfectly increasing linear data', () => {
    const data = [1, 2, 3, 4, 5];
    const result = calculateAnomalyCorrelation(data);
    expect(result).toBeCloseTo(1, 5);
  });

  it('should return -1 for perfectly decreasing linear data', () => {
    const data = [5, 4, 3, 2, 1];
    const result = calculateAnomalyCorrelation(data);
    expect(result).toBeCloseTo(-1, 5);
  });

  it('should handle mixed positive and negative numbers correctly', () => {
    const data = [-2, -1, 0, 1, 2];
    const result = calculateAnomalyCorrelation(data);
    expect(result).toBeCloseTo(1, 5);
  });

  it('should return 0 for uncorrelated data', () => {
    const data = [1, -1, 1, -1, 1];
    const result = calculateAnomalyCorrelation(data);
    expect(result).toBeCloseTo(0, 5);
  });

  it('should return NaN for an array of identical values', () => {
    const data = [3, 3, 3, 3, 3];
    const result = calculateAnomalyCorrelation(data);
    expect(Number.isNaN(result)).toBe(true);
  });

  it('should throw TypeError when input is null', () => {
    // @ts-expect-error testing runtime behavior
    expect(() => calculateAnomalyCorrelation(null)).toThrow(TypeError);
  });

  it('should throw TypeError when input is undefined', () => {
    // @ts-expect-error testing runtime behavior
    expect(() => calculateAnomalyCorrelation(undefined)).toThrow(TypeError);
  });

  it('should handle empty array by returning NaN', () => {
    const result = calculateAnomalyCorrelation([]);
    expect(Number.isNaN(result)).toBe(true);
  });

  it('should handle array with a single element by returning NaN', () => {
    const result = calculateAnomalyCorrelation([42]);
    expect(Number.isNaN(result)).toBe(true);
  });

  it('should correctly process large dataset (boundary condition)', () => {
    const data = Array.from({ length: 1000 }, (_, i) => i);