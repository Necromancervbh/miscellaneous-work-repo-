/**
 * Pipeline Middleware Interceptor for Anomaly Correlation Forecast Scheduler
 */
export function createMiddleware(handler) {
  return async (ctx, next) => {
    await handler(ctx);
    return next();
  };
}
