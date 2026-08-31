/**
 * Pipeline Middleware Interceptor for Anomaly Detection Aggregator
 */
export function createMiddleware(handler) {
  return async (ctx, next) => {
    await handler(ctx);
    return next();
  };
}
