/**
 * Pipeline Middleware Interceptor for Anomaly Correlation Notifier
 */
export function createMiddleware(handler) {
  return async (ctx, next) => {
    await handler(ctx);
    return next();
  };
}
