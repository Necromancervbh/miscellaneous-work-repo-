import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import { Server as WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import NodeCache from 'node-cache';
import bodyParser from 'body-parser';
import { randomBytes } from 'crypto';

// ---------- Configuration ----------
const JWT_SECRET = process.env.JWT_SECRET || randomBytes(32).toString('hex');
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const WINDOW_SIZE = 500; // number of recent samples to keep
const BIN_COUNT = 20; // number of bins per feature for histogram
const ALERT_THRESHOLD = 0.5; // KL divergence threshold to trigger alert
const PCA_COMPONENTS = 3; // number of principal components
const PCA_LEARNING_RATE = 0.01; // learning rate for Oja's algorithm
const CACHE_TTL_SECONDS = 60; // cache recent drift scores for 60 seconds

// ---------- Helper Types ----------
type FeatureVector = number[];
type Histogram = number[];
type Distribution = number[];
type DriftScore = { timestamp: number; klDiv: number };

// ---------- Rolling Histogram ----------
class RollingHistogram {
    private binEdges: number[];
    private counts: number[];
    private window: number[];
    private maxSize: number;

    constructor(min: number, max: number, binCount: number, maxSize: number) {
        if (binCount < 2) throw new Error('binCount must be at least 2');
        this.binEdges = Array.from({ length: binCount + 1 }, (_, i) => min + ((max - min) * i) / binCount);
        this.counts = new Array(binCount).fill(0);
        this.window = [];
        this.maxSize = maxSize;
    }

    private findBin(value: number): number {
        // binary search for bin index
        let low = 0;
        let high = this.binEdges.length - 2;
        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            if (value >= this.binEdges[mid] && value < this.binEdges[mid + 1]) {
                return mid;
            } else if (value < this.binEdges[mid]) {
                high = mid - 1;
            } else {
                low = mid + 1;
            }
        }
        // value equal to max edge falls into last bin
        return this.binEdges.length - 2;
    }

    public add(value: number): void {
        const bin = this.findBin(value);
        this.counts[bin] += 1;
        this.window.push(value);
        if (this.window.length > this.maxSize) {
            const old = this.window.shift() as number;
            const oldBin = this.findBin(old);
            this.counts[oldBin] = Math.max(0, this.counts[oldBin] - 1);
        }
    }

    public getDistribution(): Distribution {
        const total = this.window.length;
        if (total === 0) return this.counts.map(() => 0);
        return this.counts.map(c => c / total);
    }
}

// ---------- Incremental PCA (Oja's algorithm) ----------
class IncrementalPCA {
    private components: number;
    private learningRate: number;
    private weights: number[][]; // dimensions x components

    constructor(dim: number, components: number, learningRate: number) {
        if (components <= 0 || components > dim) throw new Error('Invalid number of components');
        this.components = components;
        this.learningRate = learningRate;
        // Initialize weights with small random values
        this.weights = Array.from({ length: dim }, () =>
            Array.from({ length: components }, () => (Math.random() - 0.5) * 0.01)
        );
    }

    // Update weights with a new sample vector x (dim)
    public update(x: number[]): void {
        if (x.length !== this.weights.length) {
            throw new Error('Dimension mismatch in PCA update');
        }
        const dim = x.length;
        for (let k = 0; k < this.components; k++) {
            // Compute projection y = w_k^T x
            let y = 0;
            for (let i = 0; i < dim; i++) {
                y += this.weights[i][k] * x[i];
            }
            // Oja update: w_k = w_k + η * (x * y - w_k * y^2)
            for (let i = 0; i < dim; i++) {
                const w = this.weights[i][k];
                this.weights[i][k] = w + this.learningRate * (x[i] * y - w * y * y);
            }
        }
        // Optional: orthogonalize components (Gram-Schmidt) for numerical stability
        this.orthogonalize();
    }

    private orthogonalize(): void {
        const dim = this.weights.length;
        for (let i = 0; i < this.components; i++) {
            // Normalize component i
            let norm = 0;
            for (let d = 0; d < dim; d++) {
                norm += this.weights[d][i] * this.weights[d][i];
            }
            norm = Math.sqrt(norm) || 1e-12;
            for (let d = 0; d < dim; d++) {
                this.weights[d][i] /= norm;
            }
            // Make subsequent components orthogonal to i
            for (let j = i + 1; j < this.components; j++) {
                let dot = 0;
                for (let d = 0; d < dim; d++) {
                    dot +=