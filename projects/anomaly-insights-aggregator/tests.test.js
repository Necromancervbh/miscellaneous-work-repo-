import { describe, it, expect } from 'vitest';
import { getAnomalyInsights } from './analyticsPipeline';

describe('getAnomalyInsights', () => {
  it('should correctly aggregate normal input', () => {
    const data = [10, 20, 30];
    const result = getAnomalyInsights(data);
    expect(result).toEqual({
      count: 3,
      sum: 60,
      average: 20,
      max: 30,
      min: 10,
    });
  });

  it('should handle empty array', () => {
    const data = [];
    const result = getAnomalyInsights(data);
    expect(result).toEqual({
      count: 0,
      sum: 0,
      average: 0,
      max: null,
      min: null,
    });
  });

  it('should handle zero values', () => {
    const data = [0, 0, 0];
    const result = get