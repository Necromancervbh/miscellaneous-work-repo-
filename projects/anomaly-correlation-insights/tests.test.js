import { describe, it, expect } from 'vitest';
import { analyzeAnomalies } from '../insights_service';

// Helper to generate a typical dataset
const generateNormalDataset = () => [
  { value: 10, timestamp: 1 },
  { value: 12, timestamp: 2 },
  { value: 9, timestamp: 3 },
  { value: 11, timestamp: 4 },
  { value: 13, timestamp: 5 },
];

describe('analyzeAnomalies - Normal Input', () => {
  it('should return a correlation score within expected range for typical data', () => {
    const data = generateNormalDataset();
    const result = analyzeAnomalies(data);
    expect(result).toHaveProperty('correlationScore');
    expect(typeof result.correlationScore).toBe('number');
    // Assuming correlation scores are between -1 and 1
    expect(result.correlationScore).toBeGreaterThanOrEqual(-1);
    expect(result.correlationScore).toBeLessThanOrEqual(1);
  });

  it('should include anomaly flags for detected outliers', () => {
    const data = [
      ...generateNormalDataset(),
      { value: 100, timestamp: 6 }, // obvious outlier
    ];
    const result = analyzeAnomalies(data);
    expect(result).toHaveProperty('anomalies');
    expect(Array.isArray(result.anomalies)).toBe(true);
    expect(result.anomalies.length).toBeGreaterThan(0);
    // The outlier should be flagged
    const outlier = result.anomalies.find(a => a.timestamp === 6);
    expect(outlier).toBeDefined();
    expect(outlier.value).toBe(100);
  });
});

describe('analyzeAnomalies - Edge Cases', () => {
  it('should handle an empty dataset gracefully', () => {
    const result = analyzeAnomalies([]);
    expect(result).toHaveProperty('correlationScore');
    // With no data, correlation is undefined or null; we expect null here
    expect(result.correlationScore).toBeNull();
    expect(result.anomalies).toEqual([]);
  });

  it('should treat zero values correctly', () => {
    const data = [
      { value: 0, timestamp: 1 },
      { value: 0, timestamp: 2 },
      { value: 0, timestamp: 3 },
    ];
    const result = analyzeAnomalies(data);
    expect(result.correlationScore).toBe(0);
    expect(result.anomalies).toEqual([]);
  });

  it('should return null or error for null input', () => {
    // Depending on implementation, the function might throw or return a sentinel value
    expect(() => analyzeAnomalies(null)).toThrow();
  });

  it('should handle negative numbers correctly', () => {
    const data = [
      { value: -5, timestamp: 1 },
      { value: -3, timestamp: 2 },
      { value: -4, timestamp: 3 },
      { value: -2, timestamp: 4 },
    ];
    const result = analyzeAnomalies(data);
    expect(typeof result.correlationScore).toBe('number');
    // Correlation should still be within [-1, 1]
    expect(result.correlationScore).toBeGreaterThanOrEqual(-1);
    expect(result