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
export declare const isTestMode: () => boolean;
/**
 * Middleware: if TEST_MODE, attach mock session to request
 * and skip any Shopify auth checks.
 */
export declare const testModeMiddleware: (req: Request, _res: Response, next: NextFunction) => void;
/**
 * GET /api/test-mode — lets QA agents verify if test mode is active.
 */
export declare const testModeRoute: (_req: Request, res: Response) => void;
