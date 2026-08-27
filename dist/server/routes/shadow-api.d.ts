import { Router } from 'express';
import { type LiveListingCatalogRouteDependencies } from '../live-listing-catalog-source.js';
import { type ListingWorkspaceDto } from '../listing-workspace-reader.js';
import { type EditorFacetSweep } from '../listing-editor-facet-sweep.js';
import { type EbayCategoryBrowse, type EbayCategorySearch } from '../ebay-category-search.js';
import { type ListingDraftDto } from '../listing-draft-service.js';
import { type OperationalMonitoringProjection } from '../operational-monitoring.js';
export declare const SHADOW_API_GET_PATHS: readonly ["/api/migration/status", "/api/monitoring/digest", "/api/authoritative-listings", "/api/listing-workspace", "/api/listing-editor-metadata", "/api/ebay-category-search", "/api/ebay-category-browse", "/api/listing-description-preview", "/api/listings", "/api/capabilities"];
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
    /**
     * Background used-facet enrichment sweep. Only merged when explicitly
     * provided so hand-built test routers stay snapshot-only; the default
     * production router below passes the shared production sweep.
     */
    facetSweep?: EditorFacetSweep;
    searchEbayCategories?: EbayCategorySearch;
    browseEbayCategories?: EbayCategoryBrowse;
    readMonitoring?: () => Promise<OperationalMonitoringProjection>;
}>): Router;
declare const _default: Router;
export default _default;
