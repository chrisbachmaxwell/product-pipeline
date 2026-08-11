import type { NextFunction, Request, Response } from 'express';
type SessionTokenVerifier = (token: string) => Promise<boolean>;
type ApiAuthDependencies = {
    apiKey?: () => string | undefined;
    operatorApiKeyEnabled?: () => boolean;
    production?: () => boolean;
    sessionTokenVerifier?: SessionTokenVerifier;
    testMode?: () => boolean;
};
/**
 * Verify an App Bridge session JWT locally. This performs no OAuth exchange,
 * token refresh, database access, or platform request.
 */
export declare function verifyShopifySessionToken(token: string): Promise<boolean>;
/**
 * API authentication supports either:
 * - a cryptographically verified Shopify App Bridge session JWT; or
 * - outside production only, an exact X-API-Key header behind an explicit
 *   ALLOW_OPERATOR_API_KEY=true opt-in.
 *
 * Origin, Referer, Host, CORS, and query parameters are never treated as
 * identity. Non-production TEST_MODE is the only authentication bypass.
 */
export declare function createApiKeyAuth(dependencies?: ApiAuthDependencies): (req: Request, res: Response, next: NextFunction) => Promise<void>;
export declare const apiKeyAuth: (req: Request, res: Response, next: NextFunction) => Promise<void>;
export declare const rateLimit: (req: Request, res: Response, next: NextFunction) => void;
export {};
