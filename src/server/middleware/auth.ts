import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { loadShopifyCredentials } from '../../config/credentials.js';
import { createShopifyApi } from '../../shopify/client.js';
import { isTestMode } from './test-mode.js';

type SessionTokenVerifier = (token: string) => Promise<boolean>;

type ApiAuthDependencies = {
  apiKey?: () => string | undefined;
  operatorApiKeyEnabled?: () => boolean;
  production?: () => boolean;
  sessionTokenVerifier?: SessionTokenVerifier;
  testMode?: () => boolean;
};

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function bearerToken(req: Request): string | null {
  const authorization = req.get('Authorization');
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1] ?? null;
}

/**
 * Verify an App Bridge session JWT locally. This performs no OAuth exchange,
 * token refresh, database access, or platform request.
 */
export async function verifyShopifySessionToken(token: string): Promise<boolean> {
  try {
    const credentials = await loadShopifyCredentials();
    const shopify = await createShopifyApi();
    const payload = await shopify.session.decodeSessionToken(token);
    const expectedDestination = `https://${credentials.storeDomain}`;

    return (
      payload.dest.replace(/\/$/, '') === expectedDestination &&
      payload.iss.replace(/\/$/, '') === `${expectedDestination}/admin`
    );
  } catch {
    return false;
  }
}

/**
 * API authentication supports either:
 * - a cryptographically verified Shopify App Bridge session JWT; or
 * - outside production only, an exact X-API-Key header behind an explicit
 *   ALLOW_OPERATOR_API_KEY=true opt-in.
 *
 * Origin, Referer, Host, CORS, and query parameters are never treated as
 * identity. Non-production TEST_MODE is the only authentication bypass.
 */
export function createApiKeyAuth(dependencies: ApiAuthDependencies = {}) {
  const readApiKey = dependencies.apiKey ?? (() => process.env.API_KEY);
  const operatorApiKeyEnabled = dependencies.operatorApiKeyEnabled ??
    (() => process.env.ALLOW_OPERATOR_API_KEY === 'true');
  const isProduction = dependencies.production ?? (() => process.env.NODE_ENV === 'production');
  const verifySession = dependencies.sessionTokenVerifier ?? verifyShopifySessionToken;
  const testModeEnabled = dependencies.testMode ?? isTestMode;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (testModeEnabled()) {
      next();
      return;
    }

    const expectedApiKey = readApiKey();
    const providedApiKey = req.get('X-API-Key');
    if (
      !isProduction() &&
      operatorApiKeyEnabled() &&
      expectedApiKey &&
      providedApiKey &&
      constantTimeEqual(providedApiKey, expectedApiKey)
    ) {
      next();
      return;
    }

    const sessionToken = bearerToken(req);
    if (sessionToken && await verifySession(sessionToken)) {
      next();
      return;
    }

    res.status(401).json({
      error: 'Unauthorized',
      code: 'API_AUTH_REQUIRED',
    });
  };
}

export const apiKeyAuth = createApiKeyAuth();

/**
 * Basic in-memory rate limiting. Production ingress rate limiting remains a
 * separate infrastructure concern.
 */
const rateLimitStore = new Map<string, { tokens: number; lastRefill: number }>();
const RATE_LIMIT_REQUESTS = 100;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

export const rateLimit = (req: Request, res: Response, next: NextFunction) => {
  const clientIp = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();

  let bucket = rateLimitStore.get(clientIp);
  if (!bucket) {
    bucket = { tokens: RATE_LIMIT_REQUESTS, lastRefill: now };
    rateLimitStore.set(clientIp, bucket);
  }

  const timeDiff = now - bucket.lastRefill;
  const tokensToAdd = Math.floor(timeDiff / RATE_LIMIT_WINDOW_MS * RATE_LIMIT_REQUESTS);
  bucket.tokens = Math.min(RATE_LIMIT_REQUESTS, bucket.tokens + tokensToAdd);
  bucket.lastRefill = now;

  if (bucket.tokens < 1) {
    res.set({
      'X-RateLimit-Limit': RATE_LIMIT_REQUESTS.toString(),
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': new Date(now + RATE_LIMIT_WINDOW_MS).toISOString(),
    });
    res.status(429).json({ error: 'Rate limit exceeded' });
    return;
  }

  bucket.tokens--;
  res.set({
    'X-RateLimit-Limit': RATE_LIMIT_REQUESTS.toString(),
    'X-RateLimit-Remaining': bucket.tokens.toString(),
    'X-RateLimit-Reset': new Date(bucket.lastRefill + RATE_LIMIT_WINDOW_MS).toISOString(),
  });

  next();
};
