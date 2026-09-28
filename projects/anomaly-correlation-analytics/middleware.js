/**
 * Pipeline Middleware Interceptor for Anomaly Correlation Analytics Service
 */
export function createMiddleware(handler) {
  return async (ctx, next) => {
    await handler(ctx);
    return next();
  };
}
