/**
 * GET /api/price-check — on-demand comp pricing for one catalog row.
 *
 * Read-only: resolves the row's title from the already-cached live catalog
 * snapshot (the same source `/api/authoritative-listings` serves), then runs
 * the bounded eBay Browse comp search. Zero provider writes; at most one
 * bounded provider GET per uncached normalized query. Unknown ids are a 404;
 * a query with no usable comps is an empty 200; every other failure is one
 * generic 503 with no upstream detail.
 *
 * NOT registered anywhere by importing this module — the shadow API mounts
 * it explicitly (see the integration notes in the PR/report).
 */
import { Router } from 'express';
import { getLiveListingCatalogSnapshot, } from '../live-listing-catalog-source.js';
import { checkListingPrice, derivePriceCheckQuery, PriceCheckError, } from '../ebay-price-check.js';
const MAX_ROW_ID_LENGTH = 512;
const MAX_RESPONSE_COMPS = 10;
function validRowId(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ROW_ID_LENGTH
        || /[\u0000-\u001F\u007F]/u.test(value))
        return null;
    return value;
}
/**
 * The row's search-worthy title: the Shopify product title when mapped,
 * otherwise nothing — a bare SKU is not a comp query, so title-less rows are
 * reported as not found rather than searched with garbage.
 */
function rowTitle(snapshot, rowId) {
    if (!Array.isArray(snapshot.rows) || snapshot.rows.length > 25_000)
        return null;
    const row = snapshot.rows.find((candidate) => candidate.id === rowId);
    if (row === undefined)
        return null;
    const title = row.shopify?.title;
    return typeof title === 'string' && title.trim().length > 0 ? title : null;
}
export function createPriceCheckRouter(dependencies = { getSnapshot: getLiveListingCatalogSnapshot }) {
    const router = Router();
    const runPriceCheck = dependencies.runPriceCheck ?? checkListingPrice;
    router.get('/api/price-check', async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        const rowId = validRowId(req.query.id);
        if (rowId === null) {
            res.status(404).json({ error: 'Listing was not found' });
            return;
        }
        let title = null;
        try {
            title = rowTitle(await dependencies.getSnapshot(), rowId);
        }
        catch {
            res.status(503).json({ error: 'Price check is unavailable' });
            return;
        }
        if (title === null) {
            res.status(404).json({ error: 'Listing was not found' });
            return;
        }
        try {
            const result = await runPriceCheck(title);
            res.json({
                schemaVersion: 1,
                query: result.query,
                median: result.median,
                currency: result.currency,
                sampleSize: result.sampleSize,
                comps: result.comps.slice(0, MAX_RESPONSE_COMPS),
                externalWritesPerformed: 0,
            });
        }
        catch (error) {
            if (error instanceof PriceCheckError && error.code === 'PRICE_CHECK_NO_RESULTS') {
                res.json({
                    schemaVersion: 1,
                    query: derivePriceCheckQuery(title),
                    median: null,
                    currency: null,
                    sampleSize: 0,
                    comps: [],
                    externalWritesPerformed: 0,
                });
                return;
            }
            res.status(503).json({ error: 'Price check is unavailable' });
        }
    });
    return router;
}
