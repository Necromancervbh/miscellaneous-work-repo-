/**
 * Asynchronous & Functional Execution Toolkit
 */

export function debounce(fn, wait = 150) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn.apply(this, args), wait);
  };
}

export function throttle(fn, limit = 150) {
  let inThrottle = false;
  return function (...args) {
    if (!inThrottle) {
      fn.apply(this, args);
      inThrottle = true;
      setTimeout(() => (inThrottle = false), limit);
    }
  };
}

export function pipe(...fns) {
  return (initialVal) => fns.reduce((acc, fn) => fn(acc), initialVal);
}

export async function pRetry(asyncFn, { retries = 3, delay = 200 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await asyncFn();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, delay * Math.pow(2, attempt - 1)));
      }
    }
  }
  throw lastError;
}