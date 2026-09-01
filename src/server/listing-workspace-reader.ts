import { warn } from '../utils/logger.js';
import {
  MAX_LIVE_LISTING_SNAPSHOT_AGE_MS,
  type LiveListingCatalogRow,
  type LiveListingCatalogSnapshot,
} from './live-listing-catalog.js';
import {
  getLiveListingCatalogSnapshot,
  getRuntimeEbayReadToken,
  hasUnresolvedLiveListingRefreshFailure,
  type LiveListingCatalogCacheStatus,
} from './live-listing-catalog-source.js';
import {
  createEnrichedListingDetailReader,
  EBAY_LISTING_DETAIL_MARKETPLACE_ID,
  EBAY_LISTING_DETAIL_SELLER_ID,
  type EnrichedListingDetail,
  type EnrichedListingDetailRequest,
} from './enriched-listing-detail.js';
import {
  createShopifyProductContentReader,
  type ShopifyProductContent,
} from './shopify-product-content.js';
import { getRuntimeShopifyReadToken } from './live-listing-catalog-source.js';

const BACKGROUND_REFRESH_SECONDS = 60;
const MAX_ROW_ID_LENGTH = 512;

export type ListingWorkspaceMappingState =
  | 'mapped'
  | 'shopify_only'
  | 'ebay_only_unmapped'
  | 'attention';

export type ListingWorkspaceDto = Readonly<{
  schemaVersion: 1;
  evidence: Readonly<{
    catalogObservedAtUtc: string;
    detailObservedAtUtc: string | null;
    freshness: 'live';
    backgroundRefreshSeconds: 60;
    remoteReadPerformed: boolean;
    externalWritesPerformed: 0;
  }>;
  catalog: LiveListingCatalogRow;
  mapping: Readonly<{
    state: ListingWorkspaceMappingState;
    joinKey: 'exact_raw_sku';
    shopifyProductId: string | null;
    shopifyVariantId: string | null;
    inventorySku: string | null;
    offerId: string | null;
    listingId: string | null;
    managementModel: 'inventory_offer' | 'legacy_trading' | 'none';
    ownership: Readonly<{
      listing: 'unverified';
      mapping: 'unverified';
      price: 'marketplace_connect';
      inventory: 'marketplace_connect';
    }>;
    editMode: 'read_only';
  }>;
  ebayDetail: EnrichedListingDetail | null;
  /**
   * Per-product Shopify description and media, read on demand for the draft
   * editor. Null when the read is unavailable or was not attempted — the
   * editor degrades to manual entry exactly as before, so a Shopify hiccup
   * can never block opening a draft.
   */
  shopifyContent?: ShopifyProductContent | null;
}>;

export class ListingWorkspaceReaderError extends Error {
  readonly kind: 'not_found' | 'unavailable';

  constructor(kind: 'not_found' | 'unavailable') {
    super('Listing workspace is unavailable');
    this.name = 'ListingWorkspaceReaderError';
    this.kind = kind;
  }
}

type ReadEbayDetail = (
  input: EnrichedListingDetailRequest,
) => Promise<EnrichedListingDetail>;

export type ListingWorkspaceReaderDependencies = Readonly<{
  getSnapshot: () => Promise<LiveListingCatalogSnapshot>;
  getSnapshotStatus?: () => LiveListingCatalogCacheStatus;
  getEbayAccessToken: () => Promise<string>;
  readEbayDetail: ReadEbayDetail;
  /**
   * Optional per-product Shopify description/media read. Omitted in tests and
   * in any caller that does not need draft defaults; a failure is swallowed
   * so it can never make a workspace unavailable.
   */
  readShopifyContent?: (
    productGid: string,
    variantGid: string,
  ) => Promise<ShopifyProductContent>;
  now?: () => number;
  maximumSnapshotAgeMs?: number;
}>;

function notFound(): never {
  throw new ListingWorkspaceReaderError('not_found');
}

function unavailable(): never {
  throw new ListingWorkspaceReaderError('unavailable');
}

function validateRowId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ROW_ID_LENGTH
    || /[\u0000-\u001F\u007F]/u.test(value)) return notFound();
  return value;
}

function validateTimestamp(value: unknown): number {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return unavailable();
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : unavailable();
}

function resolveExactFreshRow(
  snapshot: LiveListingCatalogSnapshot,
  requestedRowId: string,
  now: number,
  maximumAgeMs: number,
): LiveListingCatalogRow {
  const observedAt = validateTimestamp(snapshot.observedAtUtc);
  if (!Number.isSafeInteger(now) || now < 0 || now < observedAt
    || now - observedAt > maximumAgeMs) return unavailable();
  if (!Array.isArray(snapshot.rows) || snapshot.rows.length > 25_000) return unavailable();
  const matches = snapshot.rows.filter((candidate) => candidate.id === requestedRowId);
  if (matches.length === 0) return notFound();
  if (matches.length !== 1) return unavailable();
  const row = matches[0]!;
  if (row.lastVerifiedAtUtc !== snapshot.observedAtUtc
    || row.audit.verified !== true
    || row.audit.evidenceState !== 'live_verified'
    || row.audit.currentRemoteStateVerified !== true
    || row.lifecycleStatus === 'unknown') return unavailable();
  return row;
}

function exactRawSku(row: LiveListingCatalogRow): string | null {
  const ebaySku = row.ebay.sku;
  if (typeof ebaySku !== 'string' || ebaySku.length === 0 || ebaySku.length > 128
    || ebaySku.trim().length === 0 || /[\u0000-\u001F\u007F]/u.test(ebaySku)) return null;
  if (row.shopify !== null && row.shopify.sku !== ebaySku) return null;
  return ebaySku;
}

function mappingState(row: LiveListingCatalogRow): ListingWorkspaceMappingState {
  if (row.shopify === null) return 'ebay_only_unmapped';
  if (row.ebay.listingId === null && row.lifecycleStatus !== 'attention') return 'shopify_only';
  if (row.ebay.listingId !== null && row.lifecycleStatus === 'active') return 'mapped';
  return 'attention';
}

function projectMapping(row: LiveListingCatalogRow): ListingWorkspaceDto['mapping'] {
  const sku = exactRawSku(row);
  const hasListing = row.ebay.listingId !== null;
  const managementModel: ListingWorkspaceDto['mapping']['managementModel'] = !hasListing || sku === null
    ? 'none'
    : row.ebay.offerId === null ? 'legacy_trading' : 'inventory_offer';
  return Object.freeze({
    state: mappingState(row),
    joinKey: 'exact_raw_sku' as const,
    shopifyProductId: row.shopify?.productId ?? null,
    shopifyVariantId: row.shopify?.variantId ?? null,
    inventorySku: row.ebay.inventoryItemCount === 1 || hasListing ? sku : null,
    offerId: row.ebay.offerId,
    listingId: row.ebay.listingId,
    managementModel,
    ownership: Object.freeze({
      listing: 'unverified' as const,
      mapping: 'unverified' as const,
      price: 'marketplace_connect' as const,
      inventory: 'marketplace_connect' as const,
    }),
    editMode: 'read_only' as const,
  });
}

function detailRequest(
  row: LiveListingCatalogRow,
  rawSku: string,
  accessToken: string,
): EnrichedListingDetailRequest {
  const listingId = row.ebay.listingId;
  if (listingId === null) return unavailable();
  const management = row.ebay.offerId === null
    ? { model: 'legacy_trading' as const }
    : { model: 'inventory_offer' as const, offerId: row.ebay.offerId };
  return row.shopify === null
    ? Object.freeze({
      accessToken,
      sellerId: EBAY_LISTING_DETAIL_SELLER_ID,
      marketplaceId: EBAY_LISTING_DETAIL_MARKETPLACE_ID,
      mappingState: 'ebay_only_unmapped' as const,
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
      mappingState: 'mapped' as const,
      shopifyProductId: row.shopify.productId,
      shopifyVariantId: row.shopify.variantId,
      sku: rawSku,
      listingId,
      management,
    });
}

export function createListingWorkspaceReader(
  dependencies: ListingWorkspaceReaderDependencies,
) {
  const now = dependencies.now ?? Date.now;
  const maximumAgeMs = dependencies.maximumSnapshotAgeMs ?? MAX_LIVE_LISTING_SNAPSHOT_AGE_MS;
  if (!Number.isSafeInteger(maximumAgeMs) || maximumAgeMs < 1
    || maximumAgeMs > MAX_LIVE_LISTING_SNAPSHOT_AGE_MS) return unavailable();

  return async (rowId: string): Promise<ListingWorkspaceDto> => {
    const exactRowId = validateRowId(rowId);
    let snapshot: LiveListingCatalogSnapshot;
    try {
      snapshot = await dependencies.getSnapshot();
    } catch {
      return unavailable();
    }
    const row = resolveExactFreshRow(snapshot, exactRowId, now(), maximumAgeMs);
    if (hasUnresolvedLiveListingRefreshFailure(dependencies.getSnapshotStatus?.())) {
      return unavailable();
    }
    const mapping = projectMapping(row);
    const rawSku = exactRawSku(row);
    const canReadDetail = row.ebay.listingId !== null && rawSku !== null;
    let ebayDetail: EnrichedListingDetail | null = null;
    if (canReadDetail) {
      try {
        const accessToken = await dependencies.getEbayAccessToken();
        if (typeof accessToken !== 'string' || accessToken.length === 0 || accessToken.length > 4_096) {
          return unavailable();
        }
        ebayDetail = await dependencies.readEbayDetail(
          detailRequest(row, rawSku!, accessToken),
        );
      } catch {
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

    // Per-product Shopify description and media, for draft defaults. Strictly
    // best-effort: the bulk sweep does not carry this, and a failure here must
    // never make a workspace unavailable — the editor simply falls back to
    // manual entry, exactly as it behaved before.
    let shopifyContent: ShopifyProductContent | null = null;
    const shopifyProductId = row.shopify?.productId ?? '';
    const shopifyVariantId = row.shopify?.variantId ?? '';
    if (dependencies.readShopifyContent && shopifyProductId !== '' && shopifyVariantId !== '') {
      try {
        shopifyContent = await dependencies.readShopifyContent(
          shopifyProductId,
          shopifyVariantId,
        );
      } catch {
        warn('LISTING_SHOPIFY_CONTENT_READ_FAILED');
        shopifyContent = null;
      }
    }

    return Object.freeze({
      schemaVersion: 1 as const,
      evidence: Object.freeze({
        catalogObservedAtUtc: snapshot.observedAtUtc,
        detailObservedAtUtc: ebayDetail?.evidence.observedAtUtc ?? null,
        freshness: 'live' as const,
        backgroundRefreshSeconds: BACKGROUND_REFRESH_SECONDS,
        remoteReadPerformed: ebayDetail !== null,
        externalWritesPerformed: 0 as const,
      }),
      catalog: row,
      mapping,
      ebayDetail,
      shopifyContent,
    });
  };
}

const runtimeEbayDetailReader = createEnrichedListingDetailReader();
const runtimeShopifyContentReader = createShopifyProductContentReader({
  getAccessToken: getRuntimeShopifyReadToken,
});

export const readListingWorkspace = createListingWorkspaceReader({
  getSnapshot: getLiveListingCatalogSnapshot,
  getSnapshotStatus: getLiveListingCatalogSnapshot.status,
  getEbayAccessToken: getRuntimeEbayReadToken,
  readEbayDetail: runtimeEbayDetailReader,
  readShopifyContent: runtimeShopifyContentReader,
});

export const LISTING_WORKSPACE_READER_TESTING = Object.freeze({
  BACKGROUND_REFRESH_SECONDS,
  MAX_ROW_ID_LENGTH,
  exactRawSku,
  mappingState,
  projectMapping,
  resolveExactFreshRow,
});
