import { describe, it, expect } from 'vitest';
import { orchestrateAnomalyDetection } from './orchestrator';

describe('Anomaly Detection Orchestrator', () => {
  it('should detect anomalies for normal input', () => {
    const data = [10, 12, 13, 50, 11, 9];
    const result = orchestrateAnomalyDetection(data);
    expect(result).toHaveProperty('anomalies');
    expect(Array.isArray(result.anomalies)).toBe(true);
    // Assuming 50 is identified as an anomaly
    expect(result.anomalies).toContain(50);
  });

  it('should handle empty input gracefully', () => {
    const data = [];
    const result = orchestrateAnomalyDetection(data