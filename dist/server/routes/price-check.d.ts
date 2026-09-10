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
import { type LiveListingCatalogRouteDependencies } from '../live-listing-catalog-source.js';
import { type PriceCheck, type PriceCheckResult } from '../ebay-price-check.js';
export type PriceCheckResponseDto = Readonly<{
    schemaVersion: 1;
    query: string;
    median: number | null;
    currency: string | null;
    sampleSize: number;
    comps: PriceCheckResult['comps'];
    externalWritesPerformed: 0;
}>;
export declare function createPriceCheckRouter(dependencies?: Pick<LiveListingCatalogRouteDependencies, 'getSnapshot'> & Readonly<{
    runPriceCheck?: PriceCheck;
}>): Router;
