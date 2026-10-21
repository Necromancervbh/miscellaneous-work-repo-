import { describe, it, expect } from 'vitest';
import { getAnomalyCorrelation } from '../apiGateway';

describe('Anomaly Correlation API Gateway', () => {
  it('should return a correlation number for normal input', () => {
    const data = [
      { value: 10, anomalyScore: 0