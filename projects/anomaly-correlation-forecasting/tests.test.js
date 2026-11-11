import { describe, it, expect } from 'vitest';
import { calculateAnomalyCorrelation } from '../forecast_service';

// Helper to generate a simple increasing series
const generateSeries = (length, start = 1, step = 1) => {
  return Array.from({ length }, (_, i) => start + i * step);
};

describe('Anomaly Correlation Forecasting', () => {
  // Normal input test
  it('should return correct correlation for typical input series', () => {
    const observed = generateSeries(10, 10, 2); // [10,12,14,...,28]
    const forecast = generateSeries(10, 11, 2); // [11,13,15,...,29]
    const result = calculateAnomalyCorrelation(observed, forecast);
    // For perfectly aligned series with a constant offset, correlation should be 1
    expect(result).toBeCloseTo(1, 5);
  });

  // Edge case: empty arrays
  it('should handle empty input arrays gracefully', () => {
    const observed = [];
    const forecast = [];
    const result = calculateAnomalyCorrelation(observed, forecast);
    // Define expected behavior: return null when no data is available
    expect(result).toBeNull();
  });

  // Edge case: arrays containing zero values
  it('should correctly compute correlation when series contain zeros', () => {
    const observed = [0, 0, 0, 0, 0];
    const forecast = [0, 0, 0, 0, 0];
    const result = calculateAnomalyCorrelation(observed, forecast);
    // Zero variance leads to undefined correlation; expect null
    expect(result).toBeNull();
  });

  // Edge case: null inputs
  it('should return null when either input is null', () => {
    const observed = null;
    const forecast = generateSeries(5);
    expect(calculateAnomalyCorrelation(observed, forecast)).toBeNull();

    const observed2 = generateSeries(5);
    const forecast2 = null;
    expect(calculateAnomalyCorrelation(observed2, forecast2)).toBeNull();
  });

  // Edge case: negative numbers
  it('should correctly handle negative values in the series', () => {
    const observed = [-5, -3, -1, 1, 3];
    const forecast = [-4, -2, 0, 2, 4];
    const result = calculateAnomalyCorrelation(observed, forecast);
    // These series are perfectly linearly related, correlation should be 1
    expect(result).toBeCloseTo(1, 5);
  });

  // Boundary condition: mismatched lengths
  it('should return null when input arrays have different lengths', () => {
    const observed = generateSeries(5);
    const forecast = generateSeries(6);
    const result = calculateAnomalyCorrelation(observed, forecast);
    expect(result).toBeNull();
  });

  // Boundary condition: extreme values (large magnitude)
  it