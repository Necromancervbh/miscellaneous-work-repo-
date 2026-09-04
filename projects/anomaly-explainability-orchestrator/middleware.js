/**
 * Pipeline Middleware Interceptor for Anomaly Explainability Orchestrator
 */
export function createMiddleware(handler) {
  return async (ctx, next) => {
    await handler(ctx);
    return next();
  };
}
