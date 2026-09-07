/**
 * Pipeline Middleware Interceptor for Anomaly Management Platform
 */
export function createMiddleware(handler) {
  return async (ctx, next) => {
    await handler(ctx);
    return next();
  };
}
