import { describe, it, expect } from 'vitest';
import { handleAnomaly } from '../orchestratorHandler';

describe('Anomaly Explainability Orchestrator - handleAnomaly', () => {
  // Normal input test
  it('should return a valid explanation for a typical anomaly payload', async () => {
    const payload = {
      anomalyScore: 0.73,
      dataPoints: [12, 15, 9, 20],
      metadata: { id: 'abc123', timestamp: 1690000000000 },
    };

    const result = await handleAnomaly(payload);

    expect(result).toBeDefined();
    expect(result).toHaveProperty('explanation');
    expect(typeof result.explanation).toBe('string');
    expect(result).toHaveProperty('severity');
    expect(['low', 'medium', 'high']).toContain(result.severity);
    expect(result).toHaveProperty('details');
    expect(result.details).toMatchObject({
      score: payload.anomalyScore,
      dataPoints: payload.dataPoints,
    });
  });

  // Edge case: empty object
  it('should throw an error when given an empty payload', async () => {
    await expect(handleAnomaly({})).rejects.toThrowError(/payload.*required/i);
  });

  // Edge case: zero anomaly score
  it('should handle a zero anomaly score gracefully', async () => {
    const payload = {
      anomalyScore: 0,
      dataPoints: [5, 5, 5],
      metadata: { id: 'zeroScore', timestamp: Date.now() },
    };

    const result = await handleAnomaly(payload);

    expect(result).toBeDefined();
    expect(result.severity).toBe('low');
    expect(result.explanation).toContain('no significant anomaly');
  });

  // Edge case: null payload
  it('should throw an error when payload is null', async () => {
    // @ts-ignore – intentionally passing null to test runtime behavior
    await expect(handleAnomaly(null)).rejects.toThrowError(/payload.*null/i);
  });

  // Edge case: negative anomaly score
  it('should reject negative anomaly scores', async () => {
    const payload = {
      anomalyScore: -0.5,
      dataPoints: [1, 2, 3],
      metadata: { id: 'negScore', timestamp: Date.now() },
    };

    await expect(handleAnomaly(payload)).rejects.toThrowError(/anomalyScore.*negative/i);
  });

  // Boundary condition: anomalyScore exactly 1 (max)
  it('should treat a perfect anomaly score (1) as highest severity', async () => {
    const payload = {
      anomalyScore: 1,
      dataPoints: [100, 200, 300],
      metadata: { id: 'maxScore', timestamp: Date.now() },
    };

    const result = await handleAnomaly(payload);

    expect(result.severity).toBe('high');
    expect(result.explanation).toContain('critical anomaly');
    expect(result.details.score).toBe(1);
  });

  // Boundary condition: anomalyScore just below threshold for high severity (e.g., 0.9)
  it('should classify scores just below the high threshold correctly', async () => {
    const payload = {
      anomalyScore: 0.