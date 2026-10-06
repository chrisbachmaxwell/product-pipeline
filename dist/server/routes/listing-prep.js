import { Router } from 'express';
import { apiPrincipal } from '../middleware/auth.js';
import { getListingPrepStatus } from '../listing-prep.js';
/**
 * Read-only status of the listing prep runner: which not-yet-listed products
 * are ready for eBay, what Claude filled in, and what still needs a person.
 */
const EXACT_ROUTE = '/api/listing-prep';
const EXACT_STORE = 'usedcameragear.myshopify.com';
export function createListingPrepRouter() {
    const router = Router();
    router.get(EXACT_ROUTE, (req, res) => {
        const principal = apiPrincipal(req);
        if (principal?.kind !== 'shopify_session'
            || principal.shopifyStoreDomain !== EXACT_STORE) {
            res.status(403).json({ error: 'Requires a signed-in Shopify session' });
            return;
        }
        res.json({ schemaVersion: 1, ...getListingPrepStatus() });
    });
    return router;
}
export default createListingPrepRouter();
