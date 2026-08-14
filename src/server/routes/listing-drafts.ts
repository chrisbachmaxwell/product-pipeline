import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import { warn } from '../../utils/logger.js';
import { apiPrincipal } from '../middleware/auth.js';
import {
  ListingDraftServiceError,
  createListingDraftService,
  parseSaveListingDraftRequest,
  type ListingDraftFailureCode,
  type ListingDraftService,
} from '../listing-draft-service.js';

const EXACT_ROUTE = '/api/listing-draft';
const EXACT_STORE = 'usedcameragear.myshopify.com';
const WRITE_WINDOW_MS = 10 * 60_000;
const WRITE_LIMIT = 20;
const MAX_WRITE_RATE_BUCKETS = 2_000;

const STATUS: Readonly<Record<ListingDraftFailureCode, number>> = Object.freeze({
  LISTING_DRAFT_INVALID: 400,
  LISTING_DRAFT_FORBIDDEN: 403,
  LISTING_DRAFT_NOT_FOUND: 404,
  LISTING_DRAFT_STALE: 409,
  LISTING_DRAFT_UNAVAILABLE: 503,
});

const MESSAGE: Readonly<Record<ListingDraftFailureCode, string>> = Object.freeze({
  LISTING_DRAFT_INVALID: 'Local listing draft request is invalid',
  LISTING_DRAFT_FORBIDDEN: 'Local listing draft access is not allowed',
  LISTING_DRAFT_NOT_FOUND: 'Listing was not found',
  LISTING_DRAFT_STALE: 'Listing facts changed; reopen the draft',
  LISTING_DRAFT_UNAVAILABLE: 'Local listing drafts are unavailable',
});

function respondFailure(res: Response, error: unknown): void {
  const code = error instanceof ListingDraftServiceError
    ? error.code : 'LISTING_DRAFT_UNAVAILABLE';
  if (code === 'LISTING_DRAFT_UNAVAILABLE') warn('[ListingDraft] draft_route_unavailable');
  res.status(STATUS[code]).json({ error: MESSAGE[code], code });
}

function exactGetQuery(req: Request): string {
  if (req.originalUrl.split('?')[0] !== EXACT_ROUTE
    || Object.keys(req.query).length !== 1 || typeof req.query.id !== 'string') {
    throw new ListingDraftServiceError('LISTING_DRAFT_INVALID');
  }
  return req.query.id;
}

type RateEntry = { count: number; startedAt: number };
const writeRates = new Map<string, RateEntry>();
function allowDraftAttempt(subject: string, now = Date.now()): boolean {
  const key = createHash('sha256').update(subject, 'utf8').digest('hex');
  for (const [candidate, entry] of writeRates) {
    if (now - entry.startedAt >= WRITE_WINDOW_MS) writeRates.delete(candidate);
  }
  const current = writeRates.get(key);
  if (!current || now - current.startedAt >= WRITE_WINDOW_MS) {
    if (writeRates.size >= MAX_WRITE_RATE_BUCKETS) return false;
    writeRates.set(key, { count: 1, startedAt: now });
    return true;
  }
  current.count += 1;
  return current.count <= WRITE_LIMIT;
}

export function createListingDraftRouter(
  service: ListingDraftService = createListingDraftService(),
): Router {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get(EXACT_ROUTE, async (req, res) => {
    try {
      const principal = apiPrincipal(req);
      const canSave = principal?.kind === 'shopify_session'
        && principal.shopifyStoreDomain === EXACT_STORE && principal.subject !== null
        && principal.actorId === `shopify-user:${principal.subject}`;
      res.json(await service.get(exactGetQuery(req), canSave));
    }
    catch (error) { respondFailure(res, error); }
  });

  router.post(EXACT_ROUTE, async (req, res) => {
    try {
      if (req.originalUrl !== EXACT_ROUTE) {
        throw new ListingDraftServiceError('LISTING_DRAFT_FORBIDDEN');
      }
      const principal = apiPrincipal(req);
      if (principal?.kind !== 'shopify_session' || principal.shopifyStoreDomain !== EXACT_STORE
        || principal.subject === null || principal.actorId !== `shopify-user:${principal.subject}`) {
        throw new ListingDraftServiceError('LISTING_DRAFT_FORBIDDEN');
      }
      if (!allowDraftAttempt(principal.subject)) {
        res.status(429).json({ error: 'Local listing draft rate limit exceeded',
          code: 'LISTING_DRAFT_RATE_LIMITED' });
        return;
      }
      const request = parseSaveListingDraftRequest(req.body);
      res.status(201).json(await service.save(request, principal.actorId));
    } catch (error) { respondFailure(res, error); }
  });

  return router;
}

export const listingDraftJsonParser = express.json({ limit: '64kb', strict: true });

export function listingDraftJsonErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.originalUrl === EXACT_ROUTE && err instanceof Error && 'type' in err
    && (err as Error & { type?: string }).type === 'entity.too.large') {
    res.status(413).json({
      error: 'Local listing draft request is too large', code: 'LISTING_DRAFT_TOO_LARGE',
    });
    return;
  }
  if (req.originalUrl === EXACT_ROUTE && err instanceof SyntaxError) {
    res.status(400).json({
      error: 'Local listing draft request is invalid', code: 'LISTING_DRAFT_INVALID',
    });
    return;
  }
  next(err);
}

export default createListingDraftRouter();

export const LISTING_DRAFT_ROUTE_TESTING = Object.freeze({
  allowDraftAttempt,
  maximumBuckets: MAX_WRITE_RATE_BUCKETS,
  rateBucketCount() { return writeRates.size; },
  resetWriteRates() { writeRates.clear(); },
});
