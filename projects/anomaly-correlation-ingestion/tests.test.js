import { describe, it, expect } from 'vitest';
import * as ingestionPipeline from '../ingestionPipeline';

describe('Ingestion Pipeline - Anomaly Correlation Data', () => {
  // Helper to generate a mock anomaly record
  const makeRecord = ({
    id = 'rec-1',
    metric = 10,
    threshold = 5,
    timestamp = Date.now(),
    metadata = {},
  } = {}) => ({
    id,
    metric,
    threshold,
    timestamp,
    metadata,
  });

  describe('Normal input', () => {
    it('should ingest and transform a typical array of records', async () => {
      const input = [
        makeRecord({ id: 'a1', metric: 12, threshold: 8 }),
        makeRecord({ id: 'a2', metric: 20, threshold: 15 }),
      ];

      const result = await ingestionPipeline.ingestAnomalyData(input);

      // Expect same number of records returned
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(input.length);

      // Each record should contain a correlationScore between 0 and 1
      result.forEach((rec) => {
        expect(rec).toHaveProperty('correlationScore');
        expect(typeof rec.correlationScore).toBe('number');
        expect(rec.correlationScore).toBeGreaterThanOrEqual(0);
        expect(rec.correlationScore).toBeLessThanOrEqual(1);
      });
    });
  });

  describe('Edge cases', () => {
    it('should return an empty array when given an empty input', async () => {
      const result = await ingestionPipeline.ingestAnomalyData([]);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });

    it('should correctly handle records with zero values', async () => {
      const input = [
        makeRecord({ id: 'z1', metric: 0, threshold: 0 }),
        makeRecord({ id: 'z2', metric: 0, threshold: 10 }),
      ];

      const result = await ingestionPipeline.ingestAnomalyData(input);
      expect(result).toHaveLength(2);
      result.forEach((rec) => {
        expect(rec).toHaveProperty('correlationScore');
        // Zero metric should produce a defined score (e.g., 0)
        expect(typeof rec.correlationScore).toBe('number');
      });