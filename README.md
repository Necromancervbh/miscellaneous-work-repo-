# Nexus Core

> High-performance modular developer utilities, algorithms, data structures, and asynchronous helpers for modern JavaScript and TypeScript.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Build Status](https://img.shields.io/badge/build-passing-brightgreen.svg)]()
[![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen.svg)]()

---

## 📦 Overview

Nexus Core is a zero-dependency, lightweight utility suite designed for web applications, microservices, and high-throughput data processing pipelines.

## 🚀 Features

- **Core Utilities**: Deep cloning, debounce/throttle, memoization, and functional pipeline combinators.
- **Data Structures**: Priority queues, LRU/LFU caches, ring buffers, and trie structures.
- **Math & Algorithms**: Vector mathematics, matrix transformations, and statistical helpers.
- **Async & Concurrency**: Retry backoffs, semaphore locks, rate limiters, and promise pooling.
- **Zero Dependencies**: Pure, tree-shakeable ES modules with complete TypeScript definitions.

## 🛠 Installation

\\\ash
npm install nexus-core
\\\

## 📖 Quickstart

\\\javascript
import { debounce, LRUCache, createPipeline } from 'nexus-core';

// Initialize LRU Cache
const cache = new LRUCache({ capacity: 50 });
cache.set('user:101', { name: 'Alex', role: 'engineer' });

// Functional Pipeline
const compute = createPipeline(
  (x) => x * 2,
  (x) => x + 10,
  (x) => \Result: \\
);

console.log(compute(5)); // "Result: 20"
\\\

## 🧪 Testing

\\\ash
npm test
\\\

## 📄 License

MIT © Contributors