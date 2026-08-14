import { warn } from '../utils/logger.js';
import { MAX_LIVE_LISTING_SNAPSHOT_AGE_MS, } from './live-listing-catalog.js';
import { getLiveListingCatalogSnapshot, getRuntimeEbayReadToken, hasUnresolvedLiveListingRefreshFailure, } from './live-listing-catalog-source.js';
import { createEnrichedListingDetailReader, EBAY_LISTING_DETAIL_MARKETPLACE_ID, EBAY_LISTING_DETAIL_SELLER_ID, } from './enriched-listing-detail.js';
const BACKGROUND_REFRESH_SECONDS = 60;
const MAX_ROW_ID_LENGTH = 512;
export class ListingWorkspaceReaderError extends Error {
    kind;
    constructor(kind) {
        super('Listing workspace is unavailable');
        this.name = 'ListingWorkspaceReaderError';
        this.kind = kind;
    }
}
function notFound() {
    throw new ListingWorkspaceReaderError('not_found');
}
function unavailable() {
    throw new ListingWorkspaceReaderError('unavailable');
}
function validateRowId(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ROW_ID_LENGTH
        || /[\u0000-\u001F\u007F]/u.test(value))
        return notFound();
    return value;
}
function validateTimestamp(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 64)
        return unavailable();
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : unavailable();
}
function resolveExactFreshRow(snapshot, requestedRowId, now, maximumAgeMs) {
    const observedAt = validateTimestamp(snapshot.observedAtUtc);
    if (!Number.isSafeInteger(now) || now < 0 || now < observedAt
        || now - observedAt > maximumAgeMs)
        return unavailable();
    if (!Array.isArray(snapshot.rows) || snapshot.rows.length > 25_000)
        return unavailable();
    const matches = snapshot.rows.filter((candidate) => candidate.id === requestedRowId);
    if (matches.length === 0)
        return notFound();
    if (matches.length !== 1)
        return unavailable();
    const row = matches[0];
    if (row.lastVerifiedAtUtc !== snapshot.observedAtUtc
        || row.audit.verified !== true
        || row.audit.evidenceState !== 'live_verified'
        || row.audit.currentRemoteStateVerified !== true
        || row.lifecycleStatus === 'unknown')
        return unavailable();
    return row;
}
function exactRawSku(row) {
    const ebaySku = row.ebay.sku;
    if (typeof ebaySku !== 'string' || ebaySku.length === 0 || ebaySku.length > 128
        || ebaySku.trim().length === 0 || /[\u0000-\u001F\u007F]/u.test(ebaySku))
        return null;
    if (row.shopify !== null && row.shopify.sku !== ebaySku)
        return null;
    return ebaySku;
}
function mappingState(row) {
    if (row.shopify === null)
        return 'ebay_only_unmapped';
    if (row.ebay.listingId === null && row.lifecycleStatus !== 'attention')
        return 'shopify_only';
    if (row.ebay.listingId !== null && row.lifecycleStatus === 'active')
        return 'mapped';
    return 'attention';
}
function projectMapping(row) {
    const sku = exactRawSku(row);
    const hasListing = row.ebay.listingId !== null;
    const managementModel = !hasListing || sku === null
        ? 'none'
        : row.ebay.offerId === null ? 'legacy_trading' : 'inventory_offer';
    return Object.freeze({
        state: mappingState(row),
        joinKey: 'exact_raw_sku',
        shopifyProductId: row.shopify?.productId ?? null,
        shopifyVariantId: row.shopify?.variantId ?? null,
        inventorySku: row.ebay.inventoryItemCount === 1 || hasListing ? sku : null,
        offerId: row.ebay.offerId,
        listingId: row.ebay.listingId,
        managementModel,
        ownership: Object.freeze({
            listing: 'unverified',
            mapping: 'unverified',
            price: 'marketplace_connect',
            inventory: 'marketplace_connect',
        }),
        editMode: 'read_only',
    });
}
function detailRequest(row, rawSku, accessToken) {
    const listingId = row.ebay.listingId;
    if (listingId === null)
        return unavailable();
    const management = row.ebay.offerId === null
        ? { model: 'legacy_trading' }
        : { model: 'inventory_offer', offerId: row.ebay.offerId };
    return row.shopify === null
        ? Object.freeze({
            accessToken,
            sellerId: EBAY_LISTING_DETAIL_SELLER_ID,
            marketplaceId: EBAY_LISTING_DETAIL_MARKETPLACE_ID,
            mappingState: 'ebay_only_unmapped',
            shopifyProductId: null,
            shopifyVariantId: null,
            sku: rawSku,
            listingId,
            management,
        })
        : Object.freeze({
            accessToken,
            sellerId: EBAY_LISTING_DETAIL_SELLER_ID,
            marketplaceId: EBAY_LISTING_DETAIL_MARKETPLACE_ID,
            mappingState: 'mapped',
            shopifyProductId: row.shopify.productId,
            shopifyVariantId: row.shopify.variantId,
            sku: rawSku,
            listingId,
            management,
        });
}
export function createListingWorkspaceReader(dependencies) {
    const now = dependencies.now ?? Date.now;
    const maximumAgeMs = dependencies.maximumSnapshotAgeMs ?? MAX_LIVE_LISTING_SNAPSHOT_AGE_MS;
    if (!Number.isSafeInteger(maximumAgeMs) || maximumAgeMs < 1
        || maximumAgeMs > MAX_LIVE_LISTING_SNAPSHOT_AGE_MS)
        return unavailable();
    return async (rowId) => {
        const exactRowId = validateRowId(rowId);
        let snapshot;
        try {
            snapshot = await dependencies.getSnapshot();
        }
        catch {
            return unavailable();
        }
        const row = resolveExactFreshRow(snapshot, exactRowId, now(), maximumAgeMs);
        if (hasUnresolvedLiveListingRefreshFailure(dependencies.getSnapshotStatus?.())) {
            return unavailable();
        }
        const mapping = projectMapping(row);
        const rawSku = exactRawSku(row);
        const canReadDetail = row.ebay.listingId !== null && rawSku !== null;
        let ebayDetail = null;
        if (canReadDetail) {
            try {
                const accessToken = await dependencies.getEbayAccessToken();
                if (typeof accessToken !== 'string' || accessToken.length === 0 || accessToken.length > 4_096) {
                    return unavailable();
                }
                ebayDetail = await dependencies.readEbayDetail(detailRequest(row, rawSku, accessToken));
            }
            catch {
                warn('LISTING_CATALOG_DETAIL_CAPTURE_FAILED');
                return unavailable();
            }
            if (ebayDetail.identity.listingId !== row.ebay.listingId
                || ebayDetail.identity.sku !== mapping.inventorySku
                || ebayDetail.identity.offerId !== row.ebay.offerId
                || ebayDetail.identity.shopifyProductId !== mapping.shopifyProductId
                || ebayDetail.identity.shopifyVariantId !== mapping.shopifyVariantId) {
                warn('LISTING_CATALOG_DETAIL_BINDING_FAILED');
                return unavailable();
            }
        }
        return Object.freeze({
            schemaVersion: 1,
            evidence: Object.freeze({
                catalogObservedAtUtc: snapshot.observedAtUtc,
                detailObservedAtUtc: ebayDetail?.evidence.observedAtUtc ?? null,
                freshness: 'live',
                backgroundRefreshSeconds: BACKGROUND_REFRESH_SECONDS,
                remoteReadPerformed: ebayDetail !== null,
                externalWritesPerformed: 0,
            }),
            catalog: row,
            mapping,
            ebayDetail,
        });
    };
}
const runtimeEbayDetailReader = createEnrichedListingDetailReader();
export const readListingWorkspace = createListingWorkspaceReader({
    getSnapshot: getLiveListingCatalogSnapshot,
    getSnapshotStatus: getLiveListingCatalogSnapshot.status,
    getEbayAccessToken: getRuntimeEbayReadToken,
    readEbayDetail: runtimeEbayDetailReader,
});
export const LISTING_WORKSPACE_READER_TESTING = Object.freeze({
    BACKGROUND_REFRESH_SECONDS,
    MAX_ROW_ID_LENGTH,
    exactRawSku,
    mappingState,
    projectMapping,
    resolveExactFreshRow,
});
