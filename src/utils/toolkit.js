/**
 * Asynchronous & Functional Execution Utilities
 */

/**
 * Creates a debounced function that delays invoking fn until after wait milliseconds.
 */
export function debounce(fn, wait = 100) {
  let timeoutId;
  return function debounced(...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn.apply(this, args), wait);
  };
}

/**
 * Creates a throttled function that only invokes fn at most once per every wait milliseconds.
 */
export function throttle(fn, wait = 100) {
  let lastCall = 0;
  return function throttled(...args) {
    const now = Date.now();
    if (now - lastCall >= wait) {
      lastCall = now;
      return fn.apply(this, args);
    }
  };
}

/**
 * Performs left-to-right function composition.
 */
export function createPipeline(...fns) {
  return (initialValue) => fns.reduce((acc, fn) => fn(acc), initialValue);
}