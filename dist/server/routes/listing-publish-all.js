import { Router } from 'express';
import { apiPrincipal } from '../middleware/auth.js';
import { getPublishAllStatus, startPublishAllRun, } from '../publish-all.js';
/**
 * "Publish everything ready" from the operator UI (operator ask 2026-09-18:
 * "a button in the UI that we can just publish all"). The handler performs
 * zero provider writes: it starts the background publish-all runner, whose
 * every eBay write goes through the armed ceremony CLIs one item at a time
 * (see publish-all.ts). The authenticated click is the operator's one-action
 * batch approval — the same G18 pattern as the armed inventory sweep.
 * GET returns live progress so the page can show each item land.
 */
const EXACT_ROUTE = '/api/listing-publish-all';
const EXACT_STORE = 'usedcameragear.myshopify.com';
export function createListingPublishAllRouter(dependencies = {}) {
    const armedCheck = dependencies.armedCheck
        ?? (() => typeof process.env.PUBLISH_PREFLIGHT_ARGV === 'string'
            && typeof process.env.PUBLISH_DISPATCH_ARGV === 'string');
    const router = Router();
    router.get(EXACT_ROUTE, (req, res) => {
        const principal = apiPrincipal(req);
        if (principal?.kind !== 'shopify_session'
            || principal.shopifyStoreDomain !== EXACT_STORE) {
            res.status(403).json({ error: 'Requires a signed-in Shopify session' });
            return;
        }
        res.json({ schemaVersion: 1, ...getPublishAllStatus() });
    });
    router.post(EXACT_ROUTE, (req, res) => {
        if (req.originalUrl !== EXACT_ROUTE) {
            res.status(403).json({ error: 'Publish-all is scoped to the exact route' });
            return;
        }
        const principal = apiPrincipal(req);
        if (principal?.kind !== 'shopify_session' || principal.shopifyStoreDomain !== EXACT_STORE
            || principal.subject === null || principal.actorId !== `shopify-user:${principal.subject}`) {
            res.status(403).json({ error: 'Publishing requires a signed-in Shopify session' });
            return;
        }
        if (!armedCheck()) {
            res.status(409).json({
                error: 'Publishing is not armed on the server',
                code: 'PUBLISH_NOT_ARMED',
            });
            return;
        }
        const result = startPublishAllRun(principal.actorId, dependencies);
        if (!result.started) {
            res.status(409).json({
                error: 'Another publish is already running',
                code: 'PUBLISH_BUSY',
                ...getPublishAllStatus(),
            });
            return;
        }
        res.status(202).json({ schemaVersion: 1, ...getPublishAllStatus() });
    });
    return router;
}
export default createListingPublishAllRouter();
