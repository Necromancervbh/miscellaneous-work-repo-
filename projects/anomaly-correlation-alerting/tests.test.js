import { describe, it, expect } from 'vitest';
import {
  calculateCorrelation,
  shouldAlert,
  processAnomalies,
} from '../alertEngine';

describe('calculateCorrelation', () => {
  it('should return a correlation score between 0 and 1 for normal input', () => {
    const anomalies = [0.2, 0.5, 0.8, 0.6];
    const score = calculateCorrelation(anomalies);
    expect(typeof score).toBe('number');
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('should handle an empty array and return 0', () => {
    const anomalies: number[] = [];
    const score = calculateCorrelation(anomalies);
    expect(score).toBe(0);
  });

  it('should treat zero values correctly', () => {
    const anomalies = [0, 0, 0];
    const score = calculateCorrelation(anomalies);
    expect(score).toBe(0);
  });

  it('should return 0 for null input (gracefully)', () => {
    // @ts-ignore – intentionally passing null to test robustness
    const score = calculateCorrelation(null);
    expect(score).toBe(0);
  });

  it('should handle negative numbers by treating them as zero', () => {
    const anomalies = [-0.5, -1, -0.2];
    const score = calculateCorrelation(anomalies);
    expect(score).toBe(0);
  });

  it('should correctly compute score at the upper boundary (perfect correlation)', () => {
    const anomalies = [1, 1, 1, 1];
    const score = calculateCorrelation(anomalies);
    expect(score).toBeCloseTo(1);
  });
});

describe('shouldAlert', () => {
  it('should return true when score exceeds threshold', () => {
    const result = shouldAlert(0.9, 0.8);
    expect(result).toBe(true);
  });

  it('should return false when score is below threshold', () => {
    const result = shouldAlert(0.4, 0.5);
    expect(result).toBe(false);
  });

  it('should return false when score equals threshold (non‑strict)', () => {
    const result = shouldAlert(0.7, 0.7);
    expect(result).toBe(false);
  });

  it('should handle zero threshold correctly', () => {
    const result = shouldAlert(0.1, 0);
    expect(result).toBe(true);
  });

  it('should handle negative threshold as always true', () => {
    const result = shouldAlert(0.2, -0.5);
    expect(result).toBe(true);
  });

  it('should handle null inputs gracefully', () => {
    // @ts-ignore – intentionally passing null
    const result = shouldAlert(null, null);
    expect(result).toBe(false);
  });
});

describe('processAnomalies', () => {
  it('should return