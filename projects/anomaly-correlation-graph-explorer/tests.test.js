import { describe, it, expect } from 'vitest';
import {
  exploreAnomalies,
  calculateCorrelation,
  buildGraph,
  getNodeDegree,
} from './graphExplorer';

describe('Graph Explorer for Anomaly Correlations', () => {
  // Normal input tests
  describe('Normal inputs', () => {
    it('should correctly build a graph from a valid adjacency matrix', () => {
      const adjacency = [
        [0, 1, 0],
        [1, 0, 1],
        [0, 1, 0],
      ];
      const graph = buildGraph(adjacency);
      expect(graph.nodes).toHaveLength(3);
      expect(graph.edges).toHaveLength(2);
    });

    it('should calculate correct correlation for two connected nodes', () => {
      const graph = buildGraph([
        [0, 5],
        [5, 0],
      ]);
      const corr = calculateCorrelation(0, 1, graph);
      // Assuming correlation is simply the weight for this simple case
      expect(corr).toBe(5);
    });

    it('should explore anomalies and return a non‑empty result for typical data', () => {
      const data = [
        [1, 2, 3],
        [2, 4, 6],
        [3, 6, 9],
      ];
      const result = exploreAnomalies(data);
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    });
  });

  // Edge case tests
  describe('Edge cases', () => {
    it('should handle an empty adjacency matrix gracefully', () => {
      const graph = buildGraph([]);
      expect(graph.nodes).toHaveLength(0);
      expect(graph.edges).toHaveLength(0);
    });

    it('should return zero correlation for nodes with zero weight', () => {
      const graph = buildGraph([
        [0, 0],
        [0, 0],
      ]);
      const corr = calculateCorrelation(0, 1, graph);
      expect(corr).toBe(0);
    });

    it('should throw or return null when null is passed as adjacency matrix', () => {
      // Depending on implementation, either an error is thrown or null is returned
      expect(() => buildGraph(null as any)).toThrow();
    });

    it('should correctly handle negative weights in the adjacency matrix', () => {
      const graph = buildGraph([
        [0, -3],
        [-3, 0],
      ]);
      const corr = calculateCorrelation(0, 1, graph);
      // Assuming the function returns the raw weight even if negative
      expect(corr).toBe(-3);
    });

    it('should return an empty anomaly list for empty data input', () => {
      const result = exploreAnomalies([]);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });

    it('should handle data containing zero values without crashing', () => {
      const data = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ];
      const result = exploreAnomalies(data);
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // Boundary condition tests
  describe('Boundary conditions', () =>