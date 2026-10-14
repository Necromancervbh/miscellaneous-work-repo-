import { describe, it, expect } from 'vitest';
import { evaluateAnomalyCorrelation } from './alertService';

describe('evaluateAnomalyCorrelation', () => {
  // Normal input – strong positive correlation should trigger an alert
  it('should trigger an alert when correlation is above the threshold', () => {
    const seriesA = [1, 2, 3, 4, 5];
    const seriesB = [2, 4, 6, 8, 10]; // perfect positive correlation (r = 1)
    const threshold = 0.8;
    const result = evaluateAnomalyCorrelation(seriesA, seriesB, threshold);
    expect(result).toEqual({ alert: true, correlation: 1 });
  });

  // Normal input – weak correlation should not trigger an alert
  it('should not trigger an alert when correlation is below the threshold', () => {
    const seriesA = [1, 2, 3, 4, 5];
    const seriesB = [5, 4, 3, 2, 1]; // perfect negative correlation (r = -1)
    const threshold = 0.5;
    const result = evaluateAnomalyCorrelation(seriesA, seriesB, threshold);
    expect(result).toEqual({ alert: false, correlation: -1 });
  });

  // Edge case – empty input arrays
  it('should handle empty input arrays gracefully', () => {
    const seriesA: number[] = [];
    const seriesB: number[] = [];
    const threshold = 0.5;
    const result = evaluateAnomalyCorrelation(seriesA, seriesB, threshold);
    expect(result).toEqual({ alert: false, correlation: 0 });
  });

  // Edge case – arrays containing only zeros
  it('should return zero correlation for arrays of all zeros', () => {
    const seriesA = [0, 0, 0, 0];
    const seriesB = [0, 0, 0, 0];
    const threshold = 0.1;
    const result = evaluateAnomalyCorrelation(seriesA, seriesB, threshold);
    expect(result).toEqual({ alert: false, correlation: 0 });
  });

  // Edge case – null inputs
  it('should throw a TypeError when either input is null', () => {
    const seriesA = null as unknown as number[];
    const seriesB = [1, 2, 3];