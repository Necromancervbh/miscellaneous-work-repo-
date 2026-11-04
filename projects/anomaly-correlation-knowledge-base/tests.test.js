import { describe, it, expect } from 'vitest';
import { calculateCorrelation, KnowledgeBase } from './knowledgeBase';

describe('calculateCorrelation', () => {
  it('should return 1 for perfectly positively correlated data', () => {
    const x = [1, 2, 3, 4, 5];
    const y = [2, 4, 6, 8, 10];
    const result = calculateCorrelation(x, y);
    expect(result).toBeCloseTo(1);
  });

  it('should return -1 for perfectly negatively correlated data', () => {
    const x = [1, 2, 3, 4, 5];
    const y = [10, 8, 6, 4, 2];
    const result = calculateCorrelation(x, y);
    expect(result).toBeCloseTo(-1);
  });

  it('should handle zero variance (identical values) by returning NaN', () => {
    const x = [3, 3, 3, 3];
    const y = [1, 2, 3, 4];
    const result = calculateCorrelation(x, y);
    expect(result).toBeNaN();
  });

  it('should return NaN for empty input arrays', () => {
    const result = calculateCorrelation([], []);
    expect(result).toBeNaN();
  });

  it('should throw when one of the inputs is null', () => {
    // @ts-ignore – intentional misuse for test
    expect(() => calculateCorrelation(null, [1, 2, 3])).toThrow();
    // @ts-ignore – intentional misuse for test
    expect(() => calculateCorrelation([1, 2, 3], null)).toThrow();
  });

  it('should correctly compute correlation with negative numbers', () => {
    const x = [-5, -4, -3, -2, -1];
    const y = [5, 4, 3, 2, 1];
    const result = calculateCorrelation(x, y);
    expect(result).toBeCloseTo(-1);
  });

  it('should handle arrays containing zero values', () => {
    const x = [0, 1, 2, 3, 4];
    const y = [0, 2, 4, 6, 8];
    const result = calculateCorrelation(x, y);
    expect(result).toBeCloseTo(1);
  });

  it('should return NaN for arrays of length 1 (insufficient data)', () => {
    const result = calculateCorrelation([42], [24]);
    expect(result).toBeNaN();
  });

  it('should handle large numbers without overflow', () => {
    const x = [1e12, 2e12, 3e12, 4e12, 5e12];
    const y = [2e12, 4e12, 6e12, 8e12, 1e13];
    const result = calculateCorrelation(x, y);
    expect(result).toBeClose