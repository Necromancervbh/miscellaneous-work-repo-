import { describe, it, expect } from 'vitest';
import { orchestrate } from './orchestrator';

describe('Anomaly Correlation Orchestrator', () => {
  // Normal input tests
  it('should correctly compute correlation for a typical dataset', () => {
    const input = [0.1, 0.5, 0.3, 0.9, 0.7];
    const result = orchestrate(input);
    // Assuming the function returns a number between -1 and 1
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(-1);
    expect(result).toBeLessThanOrEqual(1);
  });

  it('should handle a dataset with mixed positive and negative values', () => {
    const input = [-0.2, 0.4, -0.6, 0.8, -1.0];
    const result = orchestrate(input);
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(-1);
    expect(result).toBeLessThanOrEqual(1);
  });

  // Edge case: empty array
  it('should return 0 (or appropriate neutral value) for an empty array', () => {
    const input: number[] = [];
    const result = orchestrate(input);
    expect(result).toBe(0);
  });

  // Edge case: array with a single element
  it('should return 0 (or appropriate neutral value) for a single-element array', () => {
    const input = [0.5];
    const result = orchestrate(input);
    expect(result).toBe(0);
  });

  // Edge case: array containing zeros only
  it('should handle an array of zeros correctly', () => {
    const input = [0, 0, 0, 0];
    const result = orchestrate(input);
    expect(result).toBe(0);
  });

  // Edge case: null input
  it('should throw a TypeError when input is null', () => {
    // @ts-ignore – intentionally passing wrong type
    expect(() => orchestrate(null)).toThrow(TypeError);
  });

  // Edge case: undefined input
  it('should throw a TypeError when input is undefined', () => {
    // @ts-ignore – intentionally passing wrong type
    expect(() => orchestrate(undefined)).toThrow(TypeError);
  });

  // Edge case: negative numbers
  it('should correctly process an array of negative numbers', () => {
    const input = [-5, -10, -3, -8];
    const result = orchestrate(input);
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(-1);
    expect(result).toBeLessThanOrEqual(1);
  });

  // Boundary condition: very large numbers (close to Number.MAX_SAFE_INTEGER)
  it('should handle very large numbers without overflow', () => {
    const max = Number.MAX_SAFE_INTEGER;
    const input = [max, max - 1, max - 2, max - 3];
    const result = orchestrate(input);
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThanOrEqual(-1);
    expect(result).toBeLessThanOrEqual(1);
  });

  // Boundary condition: very small (close to Number.MIN_VALUE) positive numbers
  it('should handle very small positive numbers correctly', () => {
    const min = Number.MIN_VALUE;