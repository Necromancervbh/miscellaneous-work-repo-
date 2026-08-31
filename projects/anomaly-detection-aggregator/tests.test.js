import { describe, it, expect } from 'vitest';
import { aggregateAnomalies } from './aggregator';

describe('aggregateAnomalies', () => {
  // Helper to compare numeric results with tolerance
  const expectNumber = (actual, expected) =>
    expect(actual).toBeCloseTo(expected, 5);

  it('should aggregate normal input correctly', () => {
    const data = [0.2, 0.5, 0.8, 1.0];
    const result = aggregateAnomalies(data);
    expectNumber(result.count, 4);
    expectNumber(result.sum, 2.5);
    expectNumber(result.average, 0.625);
    expectNumber(result.max, 1.0);
    expectNumber(result.min, 0.2);
    // default threshold assumed 0.5, anomalies > 0.5
    expectNumber(result.anomalies, 2); // 0.8 and 1.0
  });

  it('should handle empty array', () => {
    const result = aggregateAnomalies([]);
    expectNumber(result.count, 0);
    expectNumber(result.sum, 0);
    expectNumber(result.average, NaN);
    expect(result.max).toBeNull();
    expect(result.min).toBeNull();
    expectNumber(result.anomalies, 0);
  });

  it('should treat zeros correctly', () => {
    const result = aggregateAnomalies([0, 0, 0]);
    expectNumber(result.count, 3);
    expectNumber(result.sum, 0);
    expectNumber(result.average, 0);
    expectNumber(result.max, 0);
    expectNumber(result.min,