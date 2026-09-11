import { describe, it, expect } from 'vitest';
import { getAnomalyCorrelation } from './apiRouter';

describe('Anomaly Correlation API', () => {
  // Normal input
  it('calculates correct correlation for typical positive datasets', () => {
    const observed = [10, 20, 30, 40, 50];
    const predicted = [12, 19, 29, 41, 48];
    const result = getAnomalyCorrelation(observed, predicted);
    // Expected correlation calculated manually or via a trusted library
    const expected = 0.997; // close to perfect positive correlation
    expect(result).toBeCloseTo(expected, 3);
  });

  // Edge case: empty arrays
  it('throws an error when both input arrays are empty', () => {
    expect(() => getAnomalyCorrelation([], [])).toThrowError(/empty/i);
  });

  // Edge case: one empty array
  it('throws an error when one of the input arrays is empty', () => {
    expect(() => getAnomalyCorrelation([1, 2, 3], [])).toThrowError(/empty/i);
    expect(() => getAnomalyCorrelation([], [1, 2, 3])).toThrowError(/empty/i);
  });

  // Edge case: zero values
  it('handles arrays containing zeros correctly', () => {
    const observed = [0, 0, 0, 0, 0];
    const predicted = [0, 0, 0, 0, 0];
    const result = getAnomalyCorrelation(observed, predicted);
    // Correlation is undefined for constant series; implementation may return NaN or 0
    expect(Number.isNaN(result) || result === 0).toBeTruthy();
  });

  // Edge case: null inputs
  it('throws an error when inputs are null', () => {
    // @ts-ignore – intentionally passing wrong type
    expect(() => getAnomalyCorrelation(null, null)).toThrowError(/invalid/i);
    // @ts-ignore
    expect(() => getAnomalyCorrelation([1, 2, 3], null)).toThrowError(/invalid/i);
    // @ts-ignore
    expect(() => getAnomalyCorrelation(null, [1, 2, 3])).toThrowError(/invalid/i);
  });

  // Edge case: undefined inputs
  it('throws an error when inputs are undefined', () => {
    // @ts-ignore
    expect(() => getAnomalyCorrelation(undefined, undefined)).toThrowError(/invalid/i);
    // @ts-ignore
    expect(() => getAnomalyCorrelation([1, 2, 3], undefined)).toThrowError(/invalid/i);
    // @ts-ignore
    expect(() => getAnomalyCorrelation