import { describe, it, expect } from 'vitest';
import { explainAnomaly } from './explainabilityEngine';

describe('explainAnomaly', () => {
  it('should return a correlation score for normal input', () => {
    const actual = [1, 2, 3, 4, 5];
    const predicted = [1.1, 1.9, 3.2, 3.8, 5.1];
    const result = explainAnomaly(actual, predicted);
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(-1);
    expect(result).toBeLessThanOrEqual(1);
  });

  it('should handle empty arrays gracefully', () => {
    const result = explainAnomaly([], []);