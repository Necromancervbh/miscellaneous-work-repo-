/**
 * Pipeline Middleware Interceptor for Anomaly Correlation Explainability Service
 */
export function createMiddleware(handler) {
  return async (ctx, next) => {
    await handler(ctx);
    return next();
  };
}
