import { Router } from 'express';
import { openShadowDatabase } from '../shadow-db.js';
import { migrationStatusHandler } from './migration.js';
import { projectLiveListingCatalogPage, } from '../live-listing-catalog.js';
import { getLiveListingCatalogSnapshot, hasUnresolvedLiveListingRefreshFailure, } from '../live-listing-catalog-source.js';
import { ListingWorkspaceReaderError, readListingWorkspace, } from '../listing-workspace-reader.js';
import { buildListingEditorMetadata } from '../listing-editor-metadata.js';
import { editorFacetSweep } from '../listing-editor-facet-sweep.js';
import { EbayCategorySearchError, browseEbayCategories, searchEbayCategories, } from '../ebay-category-search.js';
import { createListingDraftService, ListingDraftServiceError, } from '../listing-draft-service.js';
import { LISTING_DESCRIPTION_TEMPLATE_VERSION, renderListingDescription, } from '../listing-description-template.js';
import { readOperationalMonitoring, } from '../operational-monitoring.js';
export const SHADOW_API_GET_PATHS = Object.freeze([
    '/api/migration/status',
    '/api/monitoring/digest',
    '/api/authoritative-listings',
    '/api/listing-workspace',
    '/api/listing-editor-metadata',
    '/api/ebay-category-search',
    '/api/ebay-category-browse',
    '/api/listing-description-preview',
    '/api/listings',
    '/api/capabilities',
]);
/** Keep browser responses narrower than the legacy product_mappings record. */
export function projectLocalListing(row) {
    return {
        id: row.id,
        shopify_product_id: String(row.shopify_product_id ?? ''),
        ebay_listing_id: String(row.ebay_listing_id ?? ''),
        status: row.status == null ? null : String(row.status),
        shopify_title: row.shopify_title == null ? null : String(row.shopify_title),
        shopify_sku: row.shopify_sku == null ? null : String(row.shopify_sku),
        shopify_price: typeof row.shopify_price === 'number' ? row.shopify_price : null,
        original_price: typeof row.original_price === 'number' ? row.original_price : null,
        updated_at: row.updated_at,
    };
}
function escapeDescriptionText(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
/**
 * Build the deterministic branded-template input for one listing draft DTO:
 * the saved draft override wins per field, then the live observed value.
 * When no draft description exists, the observed plain-text description
 * (already derived through the workspace's HTML→plain-text path) is escaped
 * into one paragraph, so the renderer's allowlist always holds. Images come
 * from the current observed listing images.
 */
export function buildListingDescriptionPreviewInput(dto) {
    const { listing, content } = dto.sections;
    const title = listing.title.draft ?? listing.title.ebay ?? listing.title.shopify;
    const draftDescription = content.description.draft;
    const observedDescription = content.description.ebay;
    const bodyHtml = draftDescription
        ?? (observedDescription === null
            ? ''
            : `<p>${escapeDescriptionText(observedDescription)}</p>`);
    const serializedImages = content.images.ebay;
    const imageUrls = serializedImages === null
        ? []
        : JSON.parse(serializedImages);
    return {
        templateVersion: LISTING_DESCRIPTION_TEMPLATE_VERSION,
        title,
        bodyHtml,
        conditionId: listing.condition.draft ?? listing.condition.ebay,
        conditionNote: listing.conditionDescription.draft ?? listing.conditionDescription.ebay,
        imageUrls,
        sku: dto.identity.rawSku,
    };
}
export function createShadowApiRouter(dependencies = {
    getSnapshot: getLiveListingCatalogSnapshot,
    getSnapshotStatus: getLiveListingCatalogSnapshot.status,
    readWorkspace: readListingWorkspace,
    facetSweep: editorFacetSweep,
    searchEbayCategories,
    browseEbayCategories,
}) {
    const router = Router();
    const workspaceReader = dependencies.readWorkspace ?? readListingWorkspace;
    const getListingDraft = dependencies.getListingDraft
        ?? ((catalogId) => createListingDraftService().get(catalogId));
    const categorySearch = dependencies.searchEbayCategories ?? searchEbayCategories;
    const categoryBrowse = dependencies.browseEbayCategories ?? browseEbayCategories;
    const monitoringReader = dependencies.readMonitoring ?? readOperationalMonitoring;
    function boundedInteger(value, fallback, minimum, maximum) {
        const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
        if (!Number.isFinite(parsed))
            return fallback;
        return Math.min(Math.max(parsed, minimum), maximum);
    }
    router.use((_req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        next();
    });
    router.get('/api/migration/status', migrationStatusHandler);
    /** GET /api/monitoring/digest — redacted, request-time, zero-provider-read operations digest. */
    router.get('/api/monitoring/digest', async (_req, res) => {
        res.json(await monitoringReader());
    });
    /** GET /api/authoritative-listings — complete live Shopify/eBay read-only census. */
    router.get('/api/authoritative-listings', async (req, res) => {
        const rawStatus = String(req.query.status ?? '').trim().toLowerCase();
        const allowedStatuses = new Set([
            'attention', 'not_listed', 'active', 'unknown',
        ]);
        if (rawStatus && !allowedStatuses.has(rawStatus)) {
            res.status(400).json({ error: 'Invalid listing status filter' });
            return;
        }
        try {
            const limit = boundedInteger(req.query.limit, 50, 1, 100);
            const offset = boundedInteger(req.query.offset, 0, 0, 1_000_000);
            const search = String(req.query.search ?? '').trim().slice(0, 200);
            const id = String(req.query.id ?? '').trim().slice(0, 256);
            const snapshot = await dependencies.getSnapshot();
            const refreshFailed = hasUnresolvedLiveListingRefreshFailure(dependencies.getSnapshotStatus?.());
            res.json(projectLiveListingCatalogPage(snapshot, {
                limit,
                offset,
                search,
                id,
                status: rawStatus ? rawStatus : undefined,
                refreshFailed,
            }));
        }
        catch {
            res.status(503).json({ error: 'Verified listing evidence is unavailable' });
        }
    });
    /** GET /api/listing-workspace — exact read-only listing control detail. */
    router.get('/api/listing-workspace', async (req, res) => {
        const rowId = typeof req.query.id === 'string' ? req.query.id : '';
        try {
            res.json(await workspaceReader(rowId));
        }
        catch (error) {
            if (error instanceof ListingWorkspaceReaderError && error.kind === 'not_found') {
                res.status(404).json({ error: 'Listing workspace was not found' });
                return;
            }
            res.status(503).json({ error: 'Verified listing workspace is unavailable' });
        }
    });
    /**
     * GET /api/listing-editor-metadata — fixed condition table plus facet usage
     * aggregated from the already-cached live catalog snapshot, merged with the
     * background used-facet sweep's cached aggregate (sweep names win). The
     * request itself never performs a new provider request and never waits on a
     * sweep: it only reads what is cached now, while an empty or expired sweep
     * cache starts one background refresh for later requests. When no
     * successful snapshot is held yet, it fails closed instead of triggering a
     * capture.
     */
    router.get('/api/listing-editor-metadata', async (_req, res) => {
        try {
            const status = dependencies.getSnapshotStatus?.();
            if (status !== undefined && status.hasSuccessfulSnapshot !== true) {
                res.status(503).json({ error: 'Listing editor metadata is unavailable' });
                return;
            }
            const sweepObservations = dependencies.facetSweep?.getObservations() ?? [];
            res.json(buildListingEditorMetadata(await dependencies.getSnapshot(), sweepObservations));
        }
        catch {
            res.status(503).json({ error: 'Listing editor metadata is unavailable' });
        }
    });
    /**
     * GET /api/ebay-category-search — read-only eBay Taxonomy category
     * suggestions for the full EBAY_US category tree (not just categories in
     * use). Performs at most one bounded remote GET per uncached normalized
     * query; results are cached in-process. Invalid queries are a 400; every
     * other failure is one generic 503 with no upstream detail.
     */
    router.get('/api/ebay-category-search', async (req, res) => {
        try {
            const query = typeof req.query.q === 'string' ? req.query.q : '';
            res.json(await categorySearch(query));
        }
        catch (error) {
            if (error instanceof EbayCategorySearchError && error.code === 'INVALID_QUERY') {
                res.status(400).json({ error: 'Invalid category search query' });
                return;
            }
            res.status(503).json({ error: 'Category search is unavailable' });
        }
    });
    /**
     * GET /api/ebay-category-browse — one level of the eBay category tree for the
     * drill-down picker. `parent` absent or empty returns the top level; any
     * other value must be an exact category id. Read-only: the whole tree is
     * fetched once and served from the in-process index, so a level costs no
     * provider call. Errors redact to the same fixed codes as the search route.
     */
    router.get('/api/ebay-category-browse', async (req, res) => {
        try {
            const parent = typeof req.query.parent === 'string' ? req.query.parent : '';
            res.json(await categoryBrowse(parent));
        }
        catch (error) {
            if (error instanceof EbayCategorySearchError && error.code === 'INVALID_QUERY') {
                res.status(400).json({ error: 'Invalid category id' });
                return;
            }
            res.status(503).json({ error: 'Category browse is unavailable' });
        }
    });
    /**
     * GET /api/listing-description-preview — render the branded description
     * template for one catalog row from the live workspace read plus the latest
     * saved local draft revision. Read-only: no store write, no provider write.
     * Unknown rows are a 404; every other failure is one generic 503.
     */
    router.get('/api/listing-description-preview', async (req, res) => {
        const rowId = typeof req.query.id === 'string' ? req.query.id : '';
        try {
            const dto = await getListingDraft(rowId);
            const html = renderListingDescription(buildListingDescriptionPreviewInput(dto));
            res.json({ templateVersion: LISTING_DESCRIPTION_TEMPLATE_VERSION, html });
        }
        catch (error) {
            if (error instanceof ListingDraftServiceError && error.code === 'LISTING_DRAFT_NOT_FOUND') {
                res.status(404).json({ error: 'Listing was not found' });
                return;
            }
            res.status(503).json({ error: 'Description preview is unavailable' });
        }
    });
    /** GET /api/listings — projected local observations only; no platform reader. */
    router.get('/api/listings', async (req, res) => {
        try {
            const db = openShadowDatabase();
            try {
                const limit = boundedInteger(req.query.limit, 50, 1, 200);
                const offset = boundedInteger(req.query.offset, 0, 0, 1_000_000);
                const search = String(req.query.search ?? '').trim().slice(0, 200);
                const statuses = String(req.query.status ?? '')
                    .split(',')
                    .map((status) => status.trim().toLowerCase())
                    .filter((status) => /^[a-z0-9_-]{1,32}$/.test(status))
                    .slice(0, 10);
                const conditions = [];
                const params = [];
                if (statuses.length > 0) {
                    conditions.push(`status IN (${statuses.map(() => '?').join(',')})`);
                    params.push(...statuses);
                }
                if (search) {
                    conditions.push('(shopify_title LIKE ? OR shopify_sku LIKE ? OR shopify_product_id LIKE ? OR ebay_listing_id LIKE ?)');
                    const pattern = `%${search}%`;
                    params.push(pattern, pattern, pattern, pattern);
                }
                const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
                const total = db.prepare(`SELECT COUNT(*) AS count FROM product_mappings ${where}`).get(...params)?.count ?? 0;
                const rows = db.prepare(`SELECT
           id,
           shopify_product_id,
           ebay_listing_id,
           status,
           shopify_title,
           shopify_sku,
           shopify_price,
           original_price,
           updated_at
         FROM product_mappings
         ${where}
         ORDER BY id DESC
         LIMIT ? OFFSET ?`).all(...params, limit, offset);
                res.json({
                    data: rows.map(projectLocalListing),
                    total,
                    limit,
                    offset,
                    source: 'product-pipeline-local-ledger',
                    authoritative: false,
                    remoteReadPerformed: false,
                });
            }
            finally {
                db.close();
            }
        }
        catch {
            res.status(500).json({ error: 'Local listing observations are unavailable' });
        }
    });
    router.get('/api/capabilities', (_req, res) => {
        res.json({
            status: 'shadow-read-only',
            dataCapabilities: [
                {
                    id: 'migration-status',
                    method: 'GET',
                    endpoint: '/api/migration/status',
                    remoteRead: false,
                },
                {
                    id: 'authoritative-listings',
                    method: 'GET',
                    endpoint: '/api/authoritative-listings',
                    remoteRead: true,
                    externalWrite: false,
                    evidenceKind: 'live_read',
                },
                {
                    id: 'listing-workspace',
                    method: 'GET',
                    endpoint: '/api/listing-workspace',
                    remoteRead: true,
                    externalWrite: false,
                    evidenceKind: 'live_read',
                    editMode: 'read_only',
                },
                {
                    id: 'listing-editor-metadata',
                    method: 'GET',
                    endpoint: '/api/listing-editor-metadata',
                    remoteRead: false,
                    externalWrite: false,
                    evidenceKind: 'cached_snapshot_aggregate',
                    backgroundRemoteRefresh: true,
                },
                {
                    id: 'ebay-category-search',
                    method: 'GET',
                    endpoint: '/api/ebay-category-search',
                    remoteRead: true,
                    externalWrite: false,
                    evidenceKind: 'live_read',
                },
                {
                    id: 'ebay-category-browse',
                    method: 'GET',
                    endpoint: '/api/ebay-category-browse',
                    remoteRead: true,
                    externalWrite: false,
                    evidenceKind: 'live_read',
                },
                {
                    id: 'listing-description-preview',
                    method: 'GET',
                    endpoint: '/api/listing-description-preview',
                    remoteRead: true,
                    externalWrite: false,
                    evidenceKind: 'live_read',
                    editMode: 'read_only',
                },
                {
                    id: 'operational-monitoring',
                    method: 'GET',
                    endpoint: '/api/monitoring/digest',
                    remoteRead: false,
                    externalWrite: false,
                    evidenceKind: 'redacted_local_aggregate',
                },
                {
                    id: 'local-listings',
                    method: 'GET',
                    endpoint: '/api/listings',
                    remoteRead: false,
                },
            ],
            mutationCapabilities: [],
            localMutationCapabilities: [{
                    id: 'local-listing-draft',
                    method: 'POST',
                    endpoint: '/api/listing-draft',
                    mounted: true,
                    availability: 'configuration-required',
                    localAppendOnly: true,
                    providerWrite: false,
                    externalWrite: false,
                    approval: false,
                    publishAuthorization: false,
                }],
            mountedApiGetRoutes: [...SHADOW_API_GET_PATHS, '/api/listing-draft'],
            legacyApiRoutesMounted: false,
            remoteReadersMounted: true,
            productionOperatorApiKeyAllowed: false,
        });
    });
    return router;
}
export default createShadowApiRouter();
