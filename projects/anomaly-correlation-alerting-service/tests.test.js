import { describe, it, expect } from 'vitest';
import { evaluateAnomaly } from '../alertDispatcher';

describe('evaluateAnomaly - Anomaly Correlation Alerting Service', () => {
  // Normal input: values above thresholds should trigger an alert
  it('should return an alert object when both scores exceed their thresholds', () => {
    const result = evaluateAnomaly({
      anomalyScore: 85,
      correlationScore: 92,
      anomalyThreshold: 80,
      correlationThreshold: 90,
    });
    expect(result).toBeTypeOf('object');
    expect(result).toHaveProperty('alertId');
    expect(result).toHaveProperty('message');
    expect(result.triggered).toBe(true);
  });

  // Normal input: one score below threshold should not trigger an alert
  it('should return null when only one score exceeds its threshold', () => {
    const result = evaluateAnomaly({
      anomalyScore: 85,
      correlationScore: 70,
      anomalyThreshold: 80,
      correlationThreshold: 90,
    });
    expect(result).toBeNull();
  });

  // Edge case: empty input object
  it('should throw an error when called with an empty object', () => {
    // @ts-ignore – intentionally passing wrong type
    expect(() => evaluateAnomaly({})).toThrowError(/missing required/i);
  });

  // Edge case: zero values
  it('should return null when scores are zero and thresholds are positive', () => {
    const result = evaluateAnomaly({
      anomalyScore: 0,
      correlationScore: 0,
      anomalyThreshold: 10,
      correlationThreshold: 10,
    });
    expect(result).toBeNull();
  });

  // Edge case: null values
  it('should throw an error when any of the numeric fields are null', () => {
    // @ts-ignore – intentionally passing null
    expect(() =>
      evaluateAnomaly({
        anomalyScore: null,
        correlationScore: 50,
        anomalyThreshold: 30,
        correlationThreshold: 40,
      })
    ).toThrowError(/invalid.*null/i);
  });

  // Edge case: negative numbers
  it('should treat negative scores as below threshold and return null', () => {
    const result = evaluateAnomaly({
      anomalyScore: -5,
      correlationScore: -10,
      anomalyThreshold: 0,
      correlationThreshold: 0,
    });
    expect(result).toBeNull();
  });

  // Edge case: negative thresholds (should be considered invalid)
  it('should throw an error when thresholds are negative', () => {
    // @ts-ignore – intentionally passing negative threshold
    expect(() =>
      evaluateAnomaly({
        anomalyScore: 50,
        correlationScore: 60,
        anomalyThreshold: -10,
        correlationThreshold: -20,
      })
    ).toThrowError(/threshold.*must be non-negative/i);
  });

  // Boundary condition: scores exactly equal to thresholds
  it('should trigger an alert when scores are exactly on the thresholds', () => {
    const result = evaluateAnomaly({
      anomalyScore: 80,
      correlationScore: 90,
      anomalyThreshold: 80,
      correlationThreshold: