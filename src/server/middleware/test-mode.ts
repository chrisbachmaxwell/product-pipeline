import { Request, Response, NextFunction } from 'express';

/**
 * TEST_MODE middleware — when TEST_MODE=true env var is set,
 * injects a mock Shopify session and skips auth so automated browser testing
 * tools can exercise the explicit shadow-read allowlist on localhost.
 */

/**
 * Test mode is deliberately unavailable in production. Setting TEST_MODE on a
 * production process must never disable API authentication or widen the route
 * surface.
 */
export const isTestMode = (): boolean => {
  const environment = process.env.NODE_ENV;
  return (
    (environment === 'test' || environment === 'development') &&
    process.env.TEST_MODE === 'true'
  );
};

/** Mock session injected into req when TEST_MODE is active */
const MOCK_SESSION = {
  shop: 'test-store.myshopify.com',
  accessToken: 'test-token',
  scope: 'read_products,read_inventory,read_orders,read_fulfillments',
  isOnline: false,
  state: 'test-state',
  id: 'test-session-id',
};

/**
 * Middleware: if TEST_MODE, attach mock session to request
 * and skip any Shopify auth checks.
 */
export const testModeMiddleware = (req: Request, _res: Response, next: NextFunction) => {
  if (isTestMode()) {
    (req as any).shopifySession = MOCK_SESSION;
    (req as any).session = MOCK_SESSION;
  }
  next();
};

/**
 * GET /api/test-mode — lets QA agents verify if test mode is active.
 */
export const testModeRoute = (_req: Request, res: Response) => {
  res.json({ testMode: isTestMode() });
};
