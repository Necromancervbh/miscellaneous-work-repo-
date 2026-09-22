import { describe, it, expect } from 'vitest';
import { 
  calculateCorrelation, 
  generateAlert, 
  processMetrics,
  ALERT_THRESHOLD 
} from './alertEngine';

describe('Anomaly Correlation Alert Service', () => {
  // Normal input tests
  describe('Normal input', () => {
    it('should correctly calculate correlation for a typical dataset', () => {
      const seriesA = [1, 2, 3, 4, 5];
      const seriesB = [2, 4, 6, 8, 10];
      const correlation = calculateCorrelation(seriesA, seriesB);
      // Perfect positive correlation should be close to 1
      expect(correlation).toBeCloseTo(1, 5);
    });

    it('should generate an alert when correlation exceeds the threshold', () => {
      const seriesA = [10, 20, 30, 40, 50];
      const seriesB = [12, 22, 32, 42, 52];
      const alert = generateAlert(seriesA, seriesB);
      expect(alert).toBeDefined();
      expect(alert?.type).toBe('ANOMALY_CORRELATION');
      expect(alert?.severity).toBeGreaterThanOrEqual(0);
    });

    it('should not generate an alert when correlation is below the threshold', () => {
      const seriesA = [1, 2, 3, 4, 5];
      const seriesB = [5, 4, 3, 2, 1];
      const alert = generateAlert(seriesA, seriesB);
      expect(alert).toBeNull();
    });
  });

  // Edge case tests
  describe('Edge cases', () => {
    it('should return null correlation for empty input arrays', () => {
      const correlation = calculateCorrelation([], []);
      expect(correlation).toBeNull();
    });

    it('should handle arrays containing only zeros', () => {
      const series = [0, 0, 0, 0];
      const correlation = calculateCorrelation(series, series);
      // Correlation is undefined when variance is zero; service should return null
      expect(correlation).toBeNull();
    });

    it('should gracefully handle null inputs', () => {
      // @ts-ignore – intentionally passing null to test robustness
      const correlation = calculateCorrelation(null, null);
      expect(correlation).toBeNull();

      // @ts-ignore
      const alert = generateAlert(null, null);
      expect(alert).toBeNull();
    });

    it('should correctly process negative numbers', () => {
      const seriesA = [-1, -2, -3, -4, -5];
      const seriesB = [-2, -4, -6, -8, -10];
      const correlation = calculateCorrelation(seriesA, seriesB);
      expect(correlation).toBeCloseTo(1, 5);
    });

    it('should not throw when one of the series contains a mix of positive, negative and zero values', () => {
      const seriesA = [0, -1, 2, -3, 4];
      const seriesB = [5, -6, 7, -8, 9];
      expect(() => calculateCorrelation(seriesA, seriesB)).not.toThrow();
      const correlation = calculateCorrelation(seriesA, seriesB);
      expect(typeof correlation).toBe('number');
    });
  });

  // Boundary condition tests
  describe('Boundary conditions', () => {
    it('should generate an alert when correlation is exactly