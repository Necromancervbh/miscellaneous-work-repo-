# Changelog

All notable changes to **Nexus Core** are documented in this file.
The project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) and [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [0.2.0] - 2026-08-30
### Added
- **`data-science`**: Implemented `anomalyDetector` module with STL moving average trend removal and z-score spike identification.
- **`tests`**: Added Vitest test suite covering boundary cases and statistical outlier calculations.
- **`types`**: Added full TypeScript definitions for time-series and pipeline utilities.

## [0.1.0] - 2026-08-30
### Added
- Initial repository architecture and modular barrel export system.
- Zero-dependency functional pipeline combinators (`createPipeline`).
- High-frequency event throttling and debouncing helpers (`debounce`, `throttle`).