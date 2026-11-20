import { describe, it, expect } from 'vitest';
import { notifyAnomaly } from '../notifier_service';

describe('Anomaly Correlation Notifier', () => {
  // Normal input tests
  it('should return a detection message for a high positive correlation', () => {
    const result = notifyAnomaly(0.85);
    expect(result).toBe('Anomaly detected');
  });

  it('should return a non‑detection message for a low positive correlation', () => {
    const result = notifyAnomaly(0.2);
    expect(result).toBe('No anomaly');
  });

  it('should correctly handle a correlation exactly at the default threshold (0.5)', () => {
    const result = notifyAnomaly(0.5);
    expect(result).toBe('No anomaly');
  });

  // Edge case tests
  it('should treat zero correlation as no anomaly', () => {
    const result = notifyAnomaly(0);
    expect(result).toBe('No anomaly');
  });

  it('should treat negative correlation as no anomaly', () => {
    const result = notifyAnomaly(-0.3);
    expect(result).toBe('No anomaly');
  });

  it('should throw a TypeError when input is null', () => {
    expect(() => notifyAnomaly(null)).toThrow(TypeError);
  });

  it('should throw a TypeError when input is undefined', () => {
    expect(() => notifyAnomaly(undefined)).toThrow(TypeError);
  });

  it('should throw a TypeError when input is an empty string', () => {
    expect(() => notifyAnomaly('')).toThrow(TypeError);
  });

  // Boundary condition tests
  it('should detect anomaly at the maximum positive correlation (1.0)', () => {
    const result = notifyAnomaly(1.0);
    expect(result).toBe('Anomaly detected');
  });

  it('should treat the minimum negative correlation (-1.0) as no anomaly', () => {
    const result = notifyAnomaly(-1.