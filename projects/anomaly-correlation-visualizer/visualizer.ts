import express, { Request, Response, NextFunction, Router } from 'express';
import bodyParser from 'body-parser';
import { PCA } from 'ml-pca';
import KMeans from 'ml-kmeans';
import { Matrix } from 'ml-matrix';
import path from 'path';
import fs from 'fs';

// Helper Types
interface CorrelationRequestBody {
    data: number[][];          // Original data matrix (rows: samples, columns: features)
    pcaComponents?: number;    // Number of PCA components to retain (default: 5)
    kClusters?: number;        // Number of clusters for K‑Means (default: 3)
}

// Utility Functions
function validateMatrix(matrix: any): matrix is number[][] {
    if (!Array.isArray(matrix) || matrix.length === 0) return false;
    const colCount = matrix[0].length;
    if (colCount === 0) return false;
    return matrix.every(row => Array.isArray(row) && row.length === colCount && row.every(v => typeof v === 'number' && !isNaN(v)));
}

/**
 * Compute Pearson correlation matrix for a given numeric matrix.
 * Formula: corr(i,j) = cov(i,j) / (σ_i * σ_j)
 * where cov(i,j) = Σ (x_i - μ_i)(x_j - μ_j) / (n - 1)
 */
function computeCorrelationMatrix(data: number[][]): number[][] {
    const m = new Matrix(data);
    const nRows = m.rows;
    const nCols = m.columns;

    // Center columns (subtract mean)
    const means = m.mean('column');
    const centered = m.clone().subRowVector(means);

    // Compute covariance matrix: (1/(n-1)) * X^T * X
    const covMatrix = centered.transpose().mmul(centered).div(nRows - 1);

    // Compute standard deviations
    const stdDevs = covMatrix.diagonal().map(v => Math.sqrt(v));

    // Build correlation matrix
    const corr = Matrix.zeros(nCols, nCols);
    for (let i = 0; i < nCols; i++) {
        for (let j = i; j < nCols; j++) {
            const denom = stdDevs[i] * stdDevs[j];
            const value = denom === 0 ? 0 : covMatrix.get(i, j) / denom;
            corr.set(i, j, value);
            corr.set(j, i, value);
        }
    }
    return corr.to2DArray();
}

// Express Router Setup
const router: Router = express.Router();
router.use(bodyParser.json({ limit: '10mb' }));

// API Route: Compute correlation matrix, PCA, K‑Means
router.post('/api/correlation', async (req: Request, res: Response, next: NextFunction) => {
    try {
        const body: CorrelationRequestBody = req.body;

        // Input validation
        if (!body || !validateMatrix(body.data)) {
            res.status(400).json({ error: 'Invalid or missing "data" matrix. Must be a non‑empty 2‑D numeric array.' });
            return;
        }

        const pcaComponents = typeof body.pcaComponents === 'number' && body.pcaComponents > 0
            ? Math.floor(body.pcaComponents)
            : 5;
        const kClusters = typeof body.kClusters === 'number' && body.kClusters > 0
            ? Math.floor(body.kClusters)
            : 3;

        // Perform PCA
        const pca = new PCA(body.data, { center: true, scale: true });
        const reduced = pca.predict(body.data, { nComponents: pcaComponents }).to2DArray();

        // Compute correlation matrix on reduced features (columns)
        const correlationMatrix = computeCorrelationMatrix(reduced);

        // K‑Means clustering on reduced rows
        const kmeansResult = KMeans(reduced, kClusters);
        const clusters = kmeansResult.clusters; // array of cluster indices per sample

        res.json({
            correlationMatrix,
            clusters,
            explainedVariance: pca.getExplainedVariance().slice(0, pcaComponents)
        });
    } catch (err) {
        next(err);
    }
});

// Serve D3 Heatmap page
router.get('/heatmap', (req: Request, res: Response) => {
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Correlation Heatmap</title>
<script src="https://d3js.org/d3.v7.min.js"></script>
<style>
  body { font-family: Arial, sans-serif; margin: 20px; }
  .cell { stroke: #fff; }
  .axis text { font-size: 10px; }
  .tooltip { position: absolute; text-align: center; padding: 4px; background: #fff; border: 1px solid #ccc; pointer-events: none; font-size: 12px; }
</style>
</head>
<body>
<h2>Correlation Heatmap (PCA‑Reduced Features)</h2>
<div id="heatmap"></div>
<script>
(async function() {
    const response = await fetch('/api/correlation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: sampleData })
    });
    if (!response.ok) {
        document.body.innerHTML += '<p style="color:red;">Failed to load data.</p>';
        return;
    }
    const result = await response.json();
    const matrix = result.correlationMatrix;
    const size = matrix.length;
    const margin = { top: 100, right: 0, bottom: 0, left: 100 };
    const cellSize = 30;
    const width = cellSize * size;
    const height = cellSize * size;

    const svg = d3.select('#heatmap')
        .append('svg')
        .attr('width', width + margin.left + margin.right)
        .attr('height', height + margin.top + margin.bottom)
        .append('g')
        .attr('transform', 'translate(' + margin.left + ',' + margin.top + ')');

    const x = d3.scaleBand().range([0, width]).domain(d3.range(size)).padding(0.01);
    const y = d3.scaleBand().range([0, height]).domain(d3.range(size)).padding(0.01);
    const color = d3.scaleSequential()
        .interpolator(d3.interpolateRdBu)
        .domain([-1, 1]);

    const tooltip = d3.select('body').append('div')
        .attr('class', 'tooltip')
        .style('opacity', 0);

    const rows = svg.selectAll('.row')
        .data(matrix)
        .enter()
        .append('g')
        .attr('class', 'row')
        .attr('transform', (d, i) => 'translate(0,' + y(i) + ')');

    rows.selectAll('.