import { describe, it, expect } from 'vitest';
import { orchestrateAnomalies } from '../orchestratorService';

describe('orchestrateAnomalies', () => {
  // Normal input
  it('should return a correlation value between -1 and 1 for a typical dataset', () => {
    const data = [
      { id: 1, value: 10 },
      { id: 2, value: 20 },
      { id: 3, value: 15 },
      { id: 4, value: 30 },
    ];
    const result = orchestrateAnomalies(data);
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(-1);
    expect(result).toBeLessThanOrEqual(1);
  });

  // Edge case: empty array
  it('should handle an empty array gracefully (return 0 correlation)', () => {
    const result = orchestrateAnomalies([]);
    expect(result).toBe(0);
  });

  // Edge case: array with a single element
  it('should return 0 correlation for a single-element dataset', () => {
    const data = [{ id: 1, value: 42 }];
    const result = orchestrateAnomalies(data);
    expect(result).toBe(0);
  });

  // Edge case: zeros in data
  it('should correctly compute correlation when all values are zero', () => {
    const data = [
      { id: 1, value: 0 },
      { id: 2, value: 0 },
      { id: 3, value: 0 },
    ];
    const result = orchestrateAnomalies(data);
    expect(result).toBe(0);
  });

  // Edge case: null input
  it('should throw an error when input is null', () => {
    // @ts-ignore – intentionally passing wrong type
    expect(() => orchestrateAnomalies(null)).toThrow();
  });

  // Edge case: undefined input
  it('should throw an error when input is undefined', () => {
    // @ts-ignore – intentionally passing wrong type
    expect(() => orchestrateAnomalies(undefined)).toThrow();
  });

  // Edge case: negative numbers
  it('should correctly handle negative values in the dataset', () => {
    const data = [
      { id: 1, value: -10 },
      { id: 2, value: -20 },
      { id: 3, value: -15 },
      { id: 4, value: -30 },
    ];
    const result = orchestrateAnomalies(data);
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(-1);
    expect(result).toBeLessThanOrEqual(1);
  });

  // Edge case: mixed positive and negative numbers
  it('should compute a valid correlation for mixed sign values', () => {
    const data = [
      { id: 1, value: -10 },
      {