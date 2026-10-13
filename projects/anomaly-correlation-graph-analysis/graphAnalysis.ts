import Graph from 'graphology';
import {undirectedGraph} from 'graphology';
import louvain from 'graphology-communities-louvain';

/**
 * Interface describing metadata for a detected anomaly cluster.
 */
export interface ClusterMetadata {
  /** Unique identifier for the cluster (Louvain community id). */
  clusterId: number;
  /** Indices of residual vectors belonging to this cluster. */
  nodeIndices: number[];
  /** Number of nodes in the cluster. */
  size: number;
  /** Centroid (mean residual vector) of the cluster. */
  centroid: number[];
}

/**
 * Validates that the residuals matrix is a non‑empty 2‑D numeric array with consistent dimensions.
 * @param residuals - Matrix of residual vectors.
 * @throws Will throw an error if validation fails.
 */
function validateResiduals(residuals: number[][]): void {
  if (!Array.isArray(residuals) || residuals.length === 0) {
    throw new Error('Residuals must be a non‑empty array of numeric arrays.');
  }
  const length = residuals[0].length;
  if (length === 0) {
    throw new Error('Residual vectors must have at least one dimension.');
  }
  for (let i = 0; i < residuals.length; i++) {
    const row = residuals[i];
    if (!Array.isArray(row) || row.length !== length) {
      throw new Error(`All residual vectors must have the same length. Row ${i} is invalid.`);
    }
    for (let j = 0; j < row.length; j++) {
      if (typeof row[j] !== 'number' || !Number.isFinite(row[j])) {
        throw new Error(`Residual at row ${i}, column ${j} is not a finite number.`);
      }
    }
  }
}

/**
 * Computes the cosine similarity between two vectors.
 * Formula: sim(a,b) = (a·b) / (||a|| * ||b||)
 * @param a - First vector.
 * @param b - Second vector.
 * @returns Cosine similarity in the range [-1, 1].
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;
  return dot / denominator;
}

/**
 * Builds an undirected similarity graph where nodes represent residual vectors and
 * edges are added when similarity exceeds the given threshold.
 * Edge weight equals the similarity value.
 * @param residuals - Matrix of residual vectors.
 * @param threshold - Minimum similarity required to create an edge (0‑1).
 * @returns Graphology undirected graph instance.
 */
function buildSimilarityGraph(residuals: number[][], threshold: number): Graph {
  const graph = new Graph({type: 'undirected'});

  // Add nodes
  for (let i = 0; i < residuals.length; i++) {
    graph.addNode(i.toString(), {index: i});
  }

  // Add edges based on similarity
  for (let i = 0; i < residuals.length; i++) {
    for (let j = i + 1; j < residuals.length; j++) {
      const sim = cosineSimilarity(residuals[i], residuals[j]);
      if (sim >= threshold) {
        graph.addEdge(i.toString(), j.toString(), {weight: sim});
      }
    }
  }

  return graph;
}

/**
 * Executes Louvain community detection on the provided graph.
 * @param graph - Undirected similarity graph.
 * @returns Mapping from node key to community id.
 */
function detectCommunities(graph: Graph): Map<string, number> {
  const communities = louvain.assign(graph);
  const result = new Map<string, number>();
  graph.forEachNode((node, attrs) => {
    const community = communities.get(node);
    if (community === undefined) {
      throw new Error(`Louvain failed to assign a community for node ${node}.`);
    }
    result.set(node, community);
  });
  return result;
}

/**
 * Computes the centroid (mean vector) of a set of residual vectors.
 * Formula: centroid_k = (1/|C|) * Σ_{i∈C} residual_i
 * @param indices - Indices of residual vectors belonging to the cluster.
 * @param residuals - Full residual matrix.
 * @returns Centroid vector.
 */
function computeCentroid(indices: number[], residuals: number[][]): number[] {
  const dim = residuals[0].length;
  const centroid = new Array<number>(dim).fill(0);
  for (const idx of indices) {
    const vec = residuals[idx];
    for (let d = 0; d < dim; d++) {
      centroid[d] += vec[d];
    }
  }
  const count = indices.length;
  for (let d = 0; d < dim; d++) {
    centroid[d] /= count;
  }
  return centroid;
}

/**
 * Main exported function that builds the similarity graph, runs Louvain detection,
 * and returns structured metadata for each anomaly cluster.
 * @param residuals - Matrix where each row is a forecast residual vector.
 * @param similarityThreshold - Cosine similarity threshold for edge creation (default 0.7).
 * @returns Array of ClusterMetadata objects sorted by descending cluster size.
 */
export function analyzeAnomalyClusters(
  residuals: number[][],
  similarityThreshold: number = 0.7
): ClusterMetadata[] {
  try {
    // Input validation
    validateResiduals(residuals);
    if (typeof similarityThreshold !== 'number' || similarityThreshold < 0 || similarityThreshold > 1) {
      throw new Error('similarityThreshold must be a number between 0 and 1.');
    }

    // Build graph
    const graph = buildSimilarityGraph(residuals, similarityThreshold);

    // If graph has no edges, each node is its own cluster
    if (graph.size === 0) {
      return residuals.map((_, idx) => ({
        clusterId: idx,
        nodeIndices: [idx],
        size: 1,
        centroid: residuals[idx].slice()
      }));
    }

    // Detect communities
    const nodeToCommunity = detectCommunities(graph);

    // Group nodes by community
    const communityMap = new Map<number, number[]>();
    nodeToCommunity.forEach((communityId, nodeKey) => {
      const idx = parseInt(nodeKey, 10);
      if (!communityMap.has(communityId)) {
        communityMap.set(communityId, []);
      }
      communityMap.get(communityId)!.push(idx);
    });

    // Build metadata
    const clusters: ClusterMetadata[] = [];
    communityMap.forEach((indices, communityId) => {