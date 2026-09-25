import { describe, it, expect } from 'vitest';
import {
  calculateCorrelation,
  normalizeData,
  detectAnomalies,
} from './insightEngine';

describe('Anomaly Correlation Insight Engine', () => {
  // Normal input tests
  describe('calculateCorrelation - normal cases', () => {
    it('should return a positive correlation for increasing series', () => {
      const data = [1, 2, 3, 4, 5];
      const result = calculateCorrelation(data);
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThanOrEqual(1);
    });

    it('should return a negative correlation for decreasing series', () => {
      const data = [5, 4, 3, 2, 1];
      const result = calculateCorrelation(data);
      expect(result).toBeLessThan(0);
      expect(result).toBeGreaterThanOrEqual(-1);
    });

    it('should return zero correlation for random uncorrelated data', () => {
      const data = [10, -3, 7, 2, -5];
      const result = calculateCorrelation(data);
      expect(Math.abs(result)).toBeLessThanOrEqual(0.5);
    });
  });

  // Edge case tests
  describe('calculateCorrelation - edge cases', () => {
    it('should return 0 for an empty array', () => {
      const result = calculateCorrelation([]);
      expect(result).toBe(0);
    });

    it('should handle an array of zeros', () => {
      const result = calculateCorrelation([0, 0, 0, 0]);
      expect(result).toBe(0);
    });

    it('should throw when input contains null', () => {
      // @ts-ignore – intentionally passing invalid data
      expect(() => calculateCorrelation([1, null, 3])).toThrow();
    });

    it('should correctly process negative numbers', () => {
      const data = [-10, -5, 0, 5, 10];
      const result = calculateCorrelation(data);
      expect(result).toBeCloseTo(1, 5);
    });

    it('should return 0 for a single-element array', () => {
      const result = calculateCorrelation([42]);
      expect(result).toBe(0);
    });
  });

  // Boundary condition tests
  describe('calculateCorrelation - boundary conditions', () => {
    it('should handle very large numbers without overflow', () => {
      const data = [1e308, 2e308, 3e308];
      const result = calculateCorrelation(data);
      expect(result).toBeGreaterThanOrEqual(-1);
      expect(result).toBeLessThanOrEqual(1);
    });

    it('should handle very small (subnormal) numbers', () => {
      const data = [Number.MIN_VALUE, Number.MIN_VALUE * 2, Number.MIN_VALUE * 3];
      const result = calculateCorrelation(data);
      expect(result).toBeCloseTo(1, 5);
    });

    it('should be symmetric: reverse input yields same magnitude', () => {
      const data = [1, 3, 5, 7, 9];
      const forward = calculateCorrelation(data);
      const reverse = calculateCorrelation([...data].reverse());
      expect(Math.abs(forward)).toBeCloseTo(Math.abs(reverse), 5);
    });
  });

  // Additional helper function tests
  describe('normalizeData', () => {
    it('should scale data to [0,1] range', () => {
      const data = [10, 20, 30];
      const