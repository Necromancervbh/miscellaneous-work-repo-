/**
 * Pipeline Middleware Interceptor for Anomaly Correlation Orchestrator
 */
export function createMiddleware(handler) {
  return async (ctx, next) => {
    await handler(ctx);
    return next();
  };
}
