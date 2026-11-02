import express, { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { Queue, Worker, QueueScheduler, Job } from 'bullmq';
import IORedis from 'ioredis';
import { body, validationResult } from 'express-validator';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

/* ==============================
   Configuration & Constants
   ============================== */
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const DBSCAN_EPS = process.env.DBSCAN_EPS ? parseFloat(process.env.DBSCAN_EPS) : 0.5;
const DBSCAN_MIN_PTS = process.env.DBSCAN_MIN_PTS ? parseInt(process.env.DBSCAN_MIN_PTS) : 5;

/* ==============================
   Types & Interfaces
   ============================== */
interface AnomalyVector {
  id: string;
  timestamp: number; // Unix epoch ms
  values: number[];
}

interface Cluster {
  id: string;
  memberIds: string[];
  centroid: number[];
}

interface Edge {
  source: string;
  target: string;
  weight: number;
}

interface Graph {
  nodes: Cluster[];
  edges: Edge[];
}

/* ==============================
   In-Memory Storage (for demo)
   ============================== */
const vectorsStore: Map<string, AnomalyVector> = new Map();
const clustersStore: Map<string, Cluster> = new Map();
let graphCache: Graph | null = null;

/* ==============================
   Utility Functions
   ============================== */
// Euclidean distance between two vectors
function euclideanDistance(a: number[], b: number[]): number {
  // d = sqrt( Σ (a_i - b_i)^2 )
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

// Compute centroid of a set of vectors
function computeCentroid(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0].length;
  const centroid = new Array(dim).fill(0);
  for (const vec of vectors) {
    for (let i = 0; i < dim; i++) {
      centroid[i] += vec[i];
    }
  }
  for (let i = 0; i < dim; i++) {
    centroid[i] /= vectors.length;
  }
  return centroid;
}

/* ==============================
   Simple DBSCAN Implementation
   ============================== */
function dbscan(
  points: AnomalyVector[],
  eps: number,
  minPts: number
): Map<string, number> {
  // Returns a map from vector id to cluster label (-1 = noise)
  const labels = new Map<string, number>();
  let clusterId = 0;

  // Helper: region query
  function regionQuery(p: AnomalyVector): AnomalyVector[] {
    const neighbors: AnomalyVector[] = [];
    for (const q of points) {
      if (euclideanDistance(p.values, q.values) <= eps) {
        neighbors.push(q);
      }
    }
    return neighbors;
  }

  // Helper: expand cluster
  function expandCluster(p: AnomalyVector, neighbors: AnomalyVector[]): void {
    labels.set(p.id, clusterId);
    const seeds = neighbors.slice();
    while (seeds.length > 0) {
      const current = seeds.shift()!;
      if (!labels.has(current.id)) {
        const result = regionQuery(current);
        if (result.length >= minPts) {
          seeds.push(...result);
        }
      }
      if (!labels.has(current.id) || labels.get(current.id) === -1) {
        labels.set(current.id, clusterId);
      }
    }
  }

  for (const point of points) {
    if (labels.has(point.id)) continue;
    const neighborPts = regionQuery(point);
    if (neighborPts.length < minPts) {
      labels.set(point.id, -1); // noise
    } else {
      expandCluster(point, neighborPts);
      clusterId++;
    }
  }

  return labels;
}

/* ==============================
   Graph Construction
   ============================== */
function buildGraph(): Graph {
  const clustersMap: Map<number, Cluster> = new Map();

  // Group vectors by cluster label
  const vectors = Array.from(vectorsStore.values());
  const labels = dbscan(vectors, DBSCAN_EPS, DBSCAN_MIN_PTS);
  for (const [vecId, label] of labels.entries()) {
    if (label === -1) continue; // ignore noise
    if (!clustersMap.has(label)) {
      clustersMap.set(label, {
        id: crypto.randomUUID(),
        memberIds: [],
        centroid: [],
      });
    }
    const cluster = clustersMap.get(label)!;
    cluster.memberIds.push(vecId);
  }

  // Compute centroids
  for (const cluster of clustersMap.values()) {
    const memberVectors = cluster.memberIds.map((id) => vectorsStore.get(id)!.values);
    cluster.centroid = computeCentroid(memberVectors);
  }

  // Build edges based on centroid distance (inverse similarity)
  const nodes = Array.from(clustersMap.values());
  const edges: Edge[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dist = euclideanDistance(nodes[i].centroid, nodes[j].centroid);
      // weight = 1 / (1 + dist) to keep it bounded (higher weight = closer)
      const weight = 1 / (1 + dist);
      edges.push({
        source: nodes[i].id,
        target: nodes[j].id,
        weight,
      });
    }
  }

  // Update stores
  clustersStore.clear();
  for (const node of nodes) {
    clustersStore.set(node.id, node);
  }

  const graph: Graph = { nodes, edges };
  graphCache = graph;
  return graph;
}

/* ==============================
   JWT Middleware
   ============================== */
function authenticateJWT(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  const token = authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Malformed Authorization header' });
  }
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    (req as any).user = user;
    next();
  });
}

/* ==============================
   Rate Limiting
   ============================== */
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});

/* ==============================
   Async Queue (BullMQ)
   ============================== */
const connection = new IORedis(REDIS_URL);
const batchQueue = new Queue('batchVectorIngestion', { connection });
new QueueScheduler('batchVectorIngestion', { connection });

const batchWorker = new Worker(
  'batchVectorIngestion',
  async (job: Job<AnomalyVector[]>) => {
    const vectors = job.data;