import express, { Router } from 'express';
import { createHash } from 'node:crypto';
import { warn } from '../../utils/logger.js';
import { apiPrincipal } from '../middleware/auth.js';
import { ListingProposalServiceError, createListingProposalService, parseListingProposalRequest, } from '../listing-proposal-service.js';
const EXACT_ROUTE = '/api/listing-proposal';
const EXACT_STORE = 'usedcameragear.myshopify.com';
const REQUEST_WINDOW_MS = 10 * 60_000;
const REQUEST_LIMIT = 30;
const MAX_RATE_BUCKETS = 2_000;
const STATUS = Object.freeze({
    LISTING_PROPOSAL_INVALID: 400,
    LISTING_PROPOSAL_FORBIDDEN: 403,
    LISTING_PROPOSAL_NOT_FOUND: 404,
    LISTING_PROPOSAL_STALE: 409,
    LISTING_PROPOSAL_BLOCKED: 422,
    LISTING_PROPOSAL_RATE_LIMITED: 429,
    LISTING_PROPOSAL_UNAVAILABLE: 503,
});
const MESSAGE = Object.freeze({
    LISTING_PROPOSAL_INVALID: 'Listing proposal request is invalid',
    LISTING_PROPOSAL_FORBIDDEN: 'Listing proposal access is not allowed',
    LISTING_PROPOSAL_NOT_FOUND: 'Listing proposal was not found',
    LISTING_PROPOSAL_STALE: 'Listing facts changed; reload this proposal',
    LISTING_PROPOSAL_BLOCKED: 'Listing proposal needs a human decision',
    LISTING_PROPOSAL_RATE_LIMITED: 'Listing proposal limit reached',
    LISTING_PROPOSAL_UNAVAILABLE: 'Listing proposals are unavailable',
});
function respondFailure(res, error) {
    const code = error instanceof ListingProposalServiceError
        ? error.code : 'LISTING_PROPOSAL_UNAVAILABLE';
    warn(`[ListingProposal] ${code.toLowerCase()}`);
    res.status(STATUS[code]).json({ error: MESSAGE[code], code });
}
function exactGetQuery(req) {
    if (req.originalUrl.split('?')[0] !== EXACT_ROUTE
        || Object.keys(req.query).length !== 1 || typeof req.query.id !== 'string') {
        throw new ListingProposalServiceError('LISTING_PROPOSAL_INVALID');
    }
    return req.query.id;
}
function verifiedPrincipal(req) {
    const principal = apiPrincipal(req);
    if (principal?.kind !== 'shopify_session'
        || principal.shopifyStoreDomain !== EXACT_STORE
        || principal.subject === null
        || principal.actorId !== `shopify-user:${principal.subject}`) {
        throw new ListingProposalServiceError('LISTING_PROPOSAL_FORBIDDEN');
    }
    return principal;
}
const requestRates = new Map();
function allowProposalAttempt(subject, now = Date.now()) {
    const key = createHash('sha256').update(subject, 'utf8').digest('hex');
    for (const [candidate, entry] of requestRates) {
        if (now - entry.startedAt >= REQUEST_WINDOW_MS)
            requestRates.delete(candidate);
    }
    const current = requestRates.get(key);
    if (!current || now - current.startedAt >= REQUEST_WINDOW_MS) {
        if (requestRates.size >= MAX_RATE_BUCKETS)
            return false;
        requestRates.set(key, { count: 1, startedAt: now });
        return true;
    }
    current.count += 1;
    return current.count <= REQUEST_LIMIT;
}
export function createListingProposalRouter(service = createListingProposalService()) {
    const router = Router();
    router.use((_req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        next();
    });
    router.get(EXACT_ROUTE, async (req, res) => {
        try {
            let authorized = false;
            try {
                verifiedPrincipal(req);
                authorized = true;
            }
            catch {
                authorized = false;
            }
            res.json(await service.get(exactGetQuery(req), authorized));
        }
        catch (error) {
            respondFailure(res, error);
        }
    });
    router.post(EXACT_ROUTE, async (req, res) => {
        try {
            if (req.originalUrl !== EXACT_ROUTE) {
                throw new ListingProposalServiceError('LISTING_PROPOSAL_FORBIDDEN');
            }
            const principal = verifiedPrincipal(req);
            if (!allowProposalAttempt(principal.subject)) {
                throw new ListingProposalServiceError('LISTING_PROPOSAL_RATE_LIMITED');
            }
            const request = parseListingProposalRequest(req.body);
            const response = request.action === 'generate_local_proposal'
                ? await service.generate(request, principal.actorId)
                : await service.approve(request, principal.actorId);
            res.status(201).json(response);
        }
        catch (error) {
            respondFailure(res, error);
        }
    });
    return router;
}
export const listingProposalJsonParser = express.json({ limit: '64kb', strict: true });
export function listingProposalJsonErrorHandler(err, req, res, next) {
    if (req.originalUrl === EXACT_ROUTE && err instanceof Error && 'type' in err
        && err.type === 'entity.too.large') {
        res.status(413).json({
            error: 'Listing proposal request is too large',
            code: 'LISTING_PROPOSAL_TOO_LARGE',
        });
        return;
    }
    if (req.originalUrl === EXACT_ROUTE && err instanceof SyntaxError) {
        res.status(400).json({
            error: 'Listing proposal request is invalid',
            code: 'LISTING_PROPOSAL_INVALID',
        });
        return;
    }
    next(err);
}
export default createListingProposalRouter();
export const LISTING_PROPOSAL_ROUTE_TESTING = Object.freeze({
    allowProposalAttempt,
    maximumBuckets: MAX_RATE_BUCKETS,
    rateBucketCount() { return requestRates.size; },
    resetRates() { requestRates.clear(); },
});
