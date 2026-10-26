import { describe, it, expect } from 'vitest';
import { monitorDrift } from './driftMonitor';

describe('monitorDrift', () => {
  // Normal input
  it('should detect no drift for stable data within threshold', () => {
    const data = [10, 11, 9, 10, 10, 11];
    const result = monitorDrift(data, 5, 2); // windowSize=5, driftThreshold=2
    expect(result.drift).toBe(false);
    expect(result.score).toBeLessThanOrEqual(2);
  });

  it('should detect drift for data that exceeds the threshold', () => {
    const data = [10, 20, 30, 40, 50];
    const result = monitorDrift(data, 5, 5);
    expect(result.drift).toBe(true);
    expect(result.score).toBeGreaterThan(5);
  });

  // Edge cases
  it('should handle empty data array gracefully', () => {
    const data: number[] = [];
    const result = monitorDrift(data, 5, 1);
    expect(result.drift).toBe(false);
    expect(result.score).toBe(0);
  });

  it('should handle data containing zeros', () => {
    const data = [0, 0, 0, 0, 0];
    const result = monitorDrift(data, 5, 0);
    expect(result.drift).toBe(false);
    expect(result.score).toBe(0);
  });

  it('should throw when data is null', () => {
    // @ts-ignore: intentional misuse for test
    expect(() => monitorDrift(null, 5, 1)).toThrow();
  });

  it('should handle negative numbers correctly', () => {
    const data = [-5, -4, -6, -5, -5];
    const result = monitorDrift(data, 5, 1);
    expect(result.drift).toBe(false);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it('should detect drift when negative values exceed threshold', () => {
    const data = [-10, -20, -30, -40, -50];
    const result = monitorDrift(data, 5, 5);
    expect(result.drift).toBe(true);
    expect(result.score).toBeGreaterThan(5);
  });

  // Boundary conditions
  it('should treat a score exactly equal to the threshold as drift', () => {
    const data = [1, 2, 3, 4, 5];
    const result = monitorDrift(data, 5, 3);
    // Assuming the implementation flags drift when score >= threshold
    expect(result.drift).toBe(true);
    expect(result.score).toBeCloseTo(3, 5);
  });

  it('should treat a score just below the threshold as no drift', () => {
    const data = [1, 1, 1,