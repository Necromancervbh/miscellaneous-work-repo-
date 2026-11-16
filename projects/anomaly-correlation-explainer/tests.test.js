import { describe, it, expect } from 'vitest';
import { explainAnomalyCorrelation } from '../explainer_service';

describe('explainAnomalyCorrelation', () => {
  // Normal input test
  it('should return a valid explanation for typical input', () => {
    const input = {
      values: [1.2, 3.4, 5.6, 7.8],
      timestamps: ['2023-01-01', '2023-01-02', '2023-01-03', '2023-01-04'],
    };
    const result = explainAnomalyCorrelation(input);
    expect(result).toBeTypeOf('object');
    expect(result).toHaveProperty('explanation');
    expect(typeof result.explanation).toBe('string');
    expect(result.explanation.length).toBeGreaterThan(0);
  });

  // Edge case: empty input
  it('should handle empty input gracefully', () => {
    const input = { values: [], timestamps: [] };
    const result = explainAnomalyCorrelation(input);
    expect(result).toBeNull();
  });

  // Edge case: zero values
  it('should handle zero values correctly', () => {
    const input = {
      values: [0, 0, 0, 0],
      timestamps: ['2023-01-01', '2023-01-02', '2023-01-03', '2023-01-04'],
    };
    const result = explainAnomalyCorrelation(input);
    expect(result).toBeNull();
  });

  // Edge case: null input
  it('should return null or throw for null input', () => {
    const input = null;
    expect(() => explainAnomalyCorrelation(input)).toThrow();
  });

  // Edge case: negative numbers
  it('should process negative numbers without error', () => {
    const input = {
      values: [-1.5, -2.3, -0.7, -4.0],
      timestamps: ['2023-01-01', '2023-01-02', '2023-01-03', '2023-01-04'],
    };
    const result = explainAnomalyCorrelation(input);
    expect(result).toBeTypeOf('object');
    expect(result).toHaveProperty('explanation');
  });

  // Boundary condition: single data point
  it('should return null for a single data point (insufficient data)', () => {
    const input = {
      values: [5.0],
      timestamps: ['2023-01-01'],
    };
    const result = explainAnomalyCorrelation(input);
    expect(result).toBeNull();
  });

  // Boundary condition: maximum allowed length (e.g., 10,000 points)
  it('should handle large input sizes efficiently', () => {
    const size = 10000;
    const values = Array.from({ length: size }, (_, i) => Math.sin(i));
    const timestamps = Array.from({ length: size }, (_, i) => `2023-01-${String(i % 30 + 1).padStart(2, '0')}`);
    const input = { values, timestamps };
    const result = explainAnomalyCorrelation(input);
    expect(result).toBeTypeOf('object');
    expect(result).toHaveProperty('explanation');
  });

  // Boundary condition: mismatched array lengths
  it('should throw an error when values and timestamps lengths differ', () => {
    const input = {
      values: [1, 2, 3],
      timestamps: ['2023-01-01