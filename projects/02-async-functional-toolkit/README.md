# ⚙️ Project: Async & Functional Toolkit

Collection of resilient async helper functions, exponential retry backoff, debouncers, and pipeline combinators for JavaScript and Node.js applications.

## Included Utilities
- `debounce(fn, ms)` — delays invocation until after idle threshold
- `throttle(fn, ms)` — limits max execution rate
- `pipe(...fns)` — left-to-right functional composition
- `pRetry(asyncFn, opts)` — exponential retry with backoff