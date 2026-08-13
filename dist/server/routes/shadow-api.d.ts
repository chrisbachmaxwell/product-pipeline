import { Router } from 'express';
import { type LiveListingCatalogRouteDependencies } from '../live-listing-catalog-source.js';
export declare const SHADOW_API_GET_PATHS: readonly ["/api/migration/status", "/api/authoritative-listings", "/api/listings", "/api/capabilities"];
export type LocalListingProjection = {
    id: number | string;
    shopify_product_id: string;
    ebay_listing_id: string;
    status: string | null;
    shopify_title: string | null;
    shopify_sku: string | null;
    shopify_price: number | null;
    original_price: number | null;
    updated_at: number | string;
};
/** Keep browser responses narrower than the legacy product_mappings record. */
export declare function projectLocalListing(row: Record<string, unknown>): LocalListingProjection;
export declare function createShadowApiRouter(dependencies?: LiveListingCatalogRouteDependencies): Router;
declare const _default: Router;
export default _default;
