/**
 * Hot-Path Memory Caching for Anomaly Correlation Analytics Service
 */
const memo = new Map();
export function memoize(fn) {
  return (arg) => {
    if (memo.has(arg)) return memo.get(arg);
    const val = fn(arg);
    memo.set(arg, val);
    return val;
  };
}
