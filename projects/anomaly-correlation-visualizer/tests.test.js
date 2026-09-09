import { describe, it, expect } from 'vitest';
import { calculateCorrelation, AnomalyCorrelationVisualizer } from './visualizer';

describe('Anomaly Correlation Visualizer - calculateCorrelation', () => {
  it('should return a valid correlation for normal input', () => {
    const data = [1, 2, 3, 4, 5];
    const result = calculateCorrelation(data);
    expect(typeof result).toBe('number');
    // Assuming perfect positive correlation for a linear increasing series
    expect(result).toBeCloseTo(1, 5);
  });

  it('should handle an empty array gracefully', () => {
    const data: number[] = [];
    const result = calculateCorrelation(data);
    // Define expected behavior: return 0 when no data is present
    expect(result).toBe(0);
  });

  it('should handle an array of zeros', () => {
    const data = [0, 0, 0, 0];
    const result = calculateCorrelation(data);
    // Correlation is undefined for constant series; assume function returns 0
    expect(result).toBe(0);
  });

  it('should throw when input is null', () => {
    // @ts-ignore – intentionally passing null to test error handling
    expect(() => calculateCorrelation(null)).toThrowError();
  });

  it('should correctly process negative numbers', () => {
    const data = [-5, -4, -3, -2, -1];
    const result = calculateCorrelation(data);
    // Negative linear series should also yield perfect positive correlation
    expect(result).toBeCloseTo(1, 5);
  });

  it('should handle mixed positive and negative numbers', () => {
    const data = [-2, -1, 0, 1, 2];
    const result = calculateCorrelation(data);
    expect(result).toBeCloseTo(1, 5);
  });

  it('should handle large numeric values without overflow', () => {
    const data = [1e12, 2e12, 3e12, 4e12, 5e12];
    const result = calculateCorrelation(data);
    expect(result).toBeCloseTo(1, 5);
  });

  it('should handle a large dataset (boundary condition)', () => {
    const data = Array.from({ length: 10000 }, (_, i) => i + 1);
    const result = calculateCorrelation(data);
    expect(result).toBeCloseTo(1, 5);
  });
});

describe('AnomalyCorrelationVisualizer class', () => {
  it('should instantiate without errors', () => {
    const visualizer = new AnomalyCorrelationVisualizer();
    expect(visualizer).toBeInstanceOf(AnomalyCorrelationVisualizer);
  });

  it('should compute correlation via instance method for normal input', () => {
    const visualizer = new AnomalyCorrelationVisualizer();
    const data = [10, 20, 30, 40, 50];
    const result = visualizer.compute(data);
    expect(typeof result).toBe('number');
    expect(result).toBe