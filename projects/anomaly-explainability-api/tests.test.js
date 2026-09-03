import { describe, it, expect } from 'vitest';
import { explainAnomaly } from './explainabilityHandler';

describe('explainAnomaly', () => {
  // Normal input
  it('should return a valid explanation for a typical positive value', () => {
    const input = { value: 42, metric: 'cpu_usage', timestamp: 1620000000 };
    const result = explainAnomaly(input);
    expect(result).toBeTypeOf('object');
    expect(result).toHaveProperty('explanation');
    expect(result).toHaveProperty('confidence');
    expect(result.explanation).toContain('42');
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  // Edge case: empty object
  it('should handle an empty input object gracefully', () => {
    const input = {};
    const result = explainAnomaly(input);
    expect(result).toBeTypeOf('object');
    expect(result.explanation).toMatch(/insufficient data/i);
    expect(result.confidence).toBe(0);
  });

  // Edge case: zero value
  it('should correctly explain a zero value', () => {
    const input = { value: 0, metric: 'memory_usage', timestamp: 1620000000 };
    const result = explainAnomaly(input);
    expect(result.explanation).toMatch(/zero/i);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
  });

  // Edge case: null input
  it('should throw a TypeError when input is null', () => {
    const input = null;
    expect(() => explainAnomaly(input)).toThrow(TypeError);
  });

  // Edge case: undefined input
  it('should throw a TypeError when input is undefined', () => {
    expect(() => explainAnomaly(undefined)).toThrow(TypeError);
  });

  // Edge case: negative numbers
  it('should handle negative values appropriately', () => {
    const input = { value: -15, metric: 'temperature', timestamp: 1620000000 };
    const result = explainAnomaly(input);
    expect(result.explanation).toMatch(/negative/i);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
  });

  // Boundary condition: very large number (close to Number.MAX_SAFE_INTEGER)
  it('should handle very large numbers without overflow', () => {
    const largeNumber = Number.MAX_SAFE_INTEGER - 1;
    const input = { value: largeNumber, metric: 'disk_io', timestamp: 1620000000 };
    const result = explainAnomaly(input);
    expect(result.explanation).toContain(String(largeNumber));
    expect(result.confidence).toBeGreaterThanOrEqual(0);
  });

  // Boundary condition: smallest positive non‑zero number
  it('should handle the smallest positive non‑zero number', () => {
    const input = { value: Number.EPSILON, metric: 'latency', timestamp: 1620000000 };
    const result = explainAnomaly(input);
    expect(result.explanation).toMatch(/very small/i);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
  });

  // Boundary condition: missing required fields
  it('should return an error explanation when required fields are missing', () => {