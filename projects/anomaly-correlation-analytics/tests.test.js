import { describe, it, expect } from 'vitest';
import {
  computeCorrelation,
  detectAnomalies,
  runAnalyticsPipeline,
} from './analytics_pipeline';

describe('Anomaly Correlation Analytics Engine', () => {
  // Normal input tests
  it('should correctly compute correlation for a typical dataset', () => {
    const seriesA = [1, 2, 3, 4, 5];
    const seriesB = [2, 4, 6, 8, 10];
    const result = computeCorrelation(seriesA, seriesB);
    // Perfect positive correlation => 1
    expect(result).toBeCloseTo(1, 5);
  });

  it('should detect anomalies in a mixed dataset', () => {
    const data = [10, 12, 11, 200, 13, 9];
    const anomalies = detectAnomalies(data, { threshold: 3 });
    expect(anomalies).toEqual([200]);
  });

  it('should run the full pipeline and return expected summary', () => {
    const input = {
      seriesA: [1, 2, 3, 4, 5],
      seriesB: [5, 4, 3, 2, 1],
      anomalyThreshold: 2,
    };
    const summary = runAnalyticsPipeline(input);
    expect(summary).toMatchObject({
      correlation: expect.any(Number),
      anomaliesA: expect.any(Array),
      anomaliesB: expect.any(Array),
    });
    // Correlation should be -1 for perfectly inverse series
    expect(summary.correlation).toBeCloseTo(-1, 5);
    expect(summary.anomaliesA).toEqual([]);
    expect(summary.anomaliesB).toEqual([]);
  });

  // Edge case: empty inputs
  it('should handle empty series for correlation', () => {
    const result = computeCorrelation([], []);
    expect(result).toBeNaN(); // Assuming function returns NaN for insufficient data
  });

  it('should return empty anomaly list for empty data', () => {
    const anomalies = detectAnomalies([], { threshold: 2 });
    expect(anomalies).toEqual([]);
  });

  // Edge case: zero values
  it('should correctly compute correlation when series contain zeros', () => {
    const seriesA = [0, 0, 0, 0];
    const seriesB = [1, 2, 3, 4];
    const result = computeCorrelation(seriesA, seriesB);
    expect(result).toBeNaN(); // Zero variance leads to undefined correlation
  });

  // Edge case: null / undefined values
  it('should throw a TypeError when series contain null', () => {
    const seriesA = [1, 2, null, 4];
    const seriesB = [2, 4, 6, 8];
    expect(() => computeCorrelation(seriesA as any, seriesB)).toThrow(TypeError);
  });

  it('should treat undefined as missing and ignore them in anomaly detection', () => {
    const data = [5, undefined, 7, 100];
    const anomalies = detectAnomalies(data as any, { threshold: 2 });
    expect(anomalies).toEqual([100]);
  });

  // Edge case: negative numbers
  it('should correctly compute correlation with negative numbers', () => {
    const seriesA = [-1, -2, -3, -4];
    const seriesB = [