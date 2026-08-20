import { Router } from 'express';
import { type LiveListingCatalogRouteDependencies } from '../live-listing-catalog-source.js';
import { type ListingWorkspaceDto } from '../listing-workspace-reader.js';
import { type ListingDraftDto } from '../listing-draft-service.js';
export declare const SHADOW_API_GET_PATHS: readonly ["/api/migration/status", "/api/authoritative-listings", "/api/listing-workspace", "/api/listing-editor-metadata", "/api/listing-description-preview", "/api/listings", "/api/capabilities"];
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
/**
 * Build the deterministic branded-template input for one listing draft DTO:
 * the saved draft override wins per field, then the live observed value.
 * When no draft description exists, the observed plain-text description
 * (already derived through the workspace's HTML→plain-text path) is escaped
 * into one paragraph, so the renderer's allowlist always holds. Images come
 * from the current observed listing images.
 */
export declare function buildListingDescriptionPreviewInput(dto: ListingDraftDto): unknown;
export declare function createShadowApiRouter(dependencies?: LiveListingCatalogRouteDependencies & Readonly<{
    readWorkspace?: (rowId: string) => Promise<ListingWorkspaceDto>;
    getListingDraft?: (catalogId: string) => Promise<ListingDraftDto>;
}>): Router;
declare const _default: Router;
export default _default;
