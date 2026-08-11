import { RESPONSIBILITIES, sha256Digest, type OperatorConfig } from '../config.js';
import {
  computeReconciliationDatasetDigest,
  type ReconciliationSnapshot,
  type ReconciliationSource,
  type SourceUnavailableReason,
} from '../reconciliation-schema.js';

export function validConfig(overrides: Partial<OperatorConfig> = {}): OperatorConfig {
  const ownership = Object.fromEntries(
    RESPONSIBILITIES.map((responsibility) => [
      responsibility,
      {
        currentOwner: responsibility === 'reconciliation' ? 'product-pipeline' : 'marketplace-connect',
        productPipelineAccess: 'read-only',
      },
    ]),
  ) as OperatorConfig['ownership'];

  return {
    schemaVersion: 1,
    project: 'product-pipeline',
    lane: 'production-shadow',
    mode: 'read-only',
    dryRun: true,
    writesEnabled: false,
    identities: {
      shopifyStoreDomain: 'usedcameragear.myshopify.com',
      ebayEnvironment: 'production',
      ebaySellerAccount: 'usedcam-0',
      marketplaceConnectAccount: 'usedcam-0',
    },
    ownership,
    orders: { importEnabled: false, historicalBackfill: false, cutoverWatermarkUtc: null },
    testLane: { shopifyVariantGids: [], skus: [], ebayListingIds: [], responsibilities: [] },
    audit: { logPath: '.local/operator-audit/operator-cli.jsonl' },
    ...overrides,
  };
}

function baseProvenance() {
  return {
    availability: 'complete' as const,
    unavailableReason: null,
    collector: { name: 'fixture', version: '2.0.0', buildCommit: 'a'.repeat(40) },
    apiVersion: null,
    capturedAtUtc: '2026-08-11T16:00:00.000Z',
    asOfStartUtc: '2026-08-11T15:00:00.000Z',
    asOfEndUtc: '2026-08-11T15:59:00.000Z',
    queryScope: {
      kind: 'bounded' as const,
      lowerBoundUtc: '2026-08-11T14:00:00.000Z',
      upperBoundUtc: '2026-08-11T16:00:00.000Z',
    },
    paginationComplete: true,
    pageCount: 1,
    recordCount: 0,
    reportedTotal: 0,
    terminalCursorDigest: null,
    normalizationVersion: '2.0.0',
    redactionVersion: '2.0.0',
    datasetDigest: null,
  };
}

export function refreshReconciliationSource(
  snapshot: ReconciliationSnapshot,
  source: ReconciliationSource,
): void {
  const bundle = snapshot.sources[source];
  let count = 0;
  switch (source) {
    case 'productPipeline':
      count = snapshot.sources.productPipeline.data.listings.length + snapshot.sources.productPipeline.data.orders.length;
      break;
    case 'shopify':
      count = snapshot.sources.shopify.data.variants.length + snapshot.sources.shopify.data.orders.length;
      break;
    case 'ebay':
      count = snapshot.sources.ebay.data.listings.length + snapshot.sources.ebay.data.orders.length;
      break;
    case 'marketplaceConnect':
      count = snapshot.sources.marketplaceConnect.data.settings.length;
      break;
  }
  bundle.provenance.recordCount = count;
  bundle.provenance.reportedTotal = count;
  bundle.provenance.datasetDigest = computeReconciliationDatasetDigest(bundle.data);
  bundle.provenance.paginationComplete = true;
  bundle.provenance.availability = 'complete';
  bundle.provenance.unavailableReason = null;
  bundle.provenance.pageCount = 1;
  bundle.provenance.apiVersion = source === 'shopify'
    ? '2025-07'
    : source === 'ebay'
      ? 'sell-v1'
      : null;
  bundle.provenance.terminalCursorDigest = sha256Digest({
    source,
    apiVersion: bundle.provenance.apiVersion,
    queryScope: bundle.provenance.queryScope,
    pageCount: bundle.provenance.pageCount,
    recordCount: count,
    reportedTotal: count,
    terminal: true,
  });
}

export function markSourceUnavailable(
  snapshot: ReconciliationSnapshot,
  source: ReconciliationSource,
  reason: SourceUnavailableReason = 'not-collected',
): void {
  switch (source) {
    case 'productPipeline':
      snapshot.sources.productPipeline.data = { listings: [], orders: [] };
      break;
    case 'shopify':
      snapshot.sources.shopify.data = { variants: [], orders: [] };
      break;
    case 'ebay':
      snapshot.sources.ebay.data = { listings: [], orders: [] };
      break;
    case 'marketplaceConnect':
      snapshot.sources.marketplaceConnect.data = { settings: [] };
      break;
  }
  const provenance = snapshot.sources[source].provenance;
  provenance.availability = 'unavailable';
  provenance.unavailableReason = reason;
  provenance.paginationComplete = false;
  provenance.pageCount = 0;
  provenance.recordCount = null;
  provenance.reportedTotal = null;
  provenance.apiVersion = null;
  provenance.terminalCursorDigest = null;
  provenance.datasetDigest = null;
}

export function validReconciliationSnapshot(
  overrides: Partial<ReconciliationSnapshot> = {},
): ReconciliationSnapshot {
  const productPipelineData: ReconciliationSnapshot['sources']['productPipeline']['data'] = {
    listings: [{
      shopifyProductId: '100',
      shopifyVariantGid: 'gid://shopify/ProductVariant/101',
      sku: 'SAFE-SKU-001',
      ebayInventoryItemSku: 'SAFE-SKU-001',
      ebayOfferId: 'OFFER-001',
      ebayListingId: 'LISTING-001',
      status: 'active',
    }],
    orders: [{ ebayOrderId: 'EBAY-ORDER-001', shopifyOrderGid: 'gid://shopify/Order/301', state: 'mapped' }],
  };
  const shopifyData: ReconciliationSnapshot['sources']['shopify']['data'] = {
    variants: [{
      shopifyProductGid: 'gid://shopify/Product/100',
      shopifyVariantGid: 'gid://shopify/ProductVariant/101',
      sku: 'SAFE-SKU-001',
      priceMinor: 12500,
      currency: 'USD',
      inventoryQuantity: 1,
    }],
    orders: [{
      shopifyOrderGid: 'gid://shopify/Order/301',
      ebayOrderId: 'EBAY-ORDER-001',
      importOwner: 'marketplace-connect',
      createdAtUtc: '2026-08-11T15:00:00.000Z',
      status: 'open',
    }],
  };
  const ebayData: ReconciliationSnapshot['sources']['ebay']['data'] = {
    listings: [{
      inventoryItemSku: 'SAFE-SKU-001',
      offerId: 'OFFER-001',
      listingId: 'LISTING-001',
      status: 'published',
      priceMinor: 12500,
      currency: 'USD',
      availableQuantity: 1,
    }],
    orders: [{ ebayOrderId: 'EBAY-ORDER-001', createdAtUtc: '2026-08-11T15:01:00.000Z', status: 'completed' }],
  };
  const marketplaceConnectData: ReconciliationSnapshot['sources']['marketplaceConnect']['data'] = {
    settings: [
      { responsibility: 'orderImport', enabled: true },
      { responsibility: 'price', enabled: true },
      { responsibility: 'inventory', enabled: true },
    ],
  };
  const snapshot: ReconciliationSnapshot = {
    schemaVersion: 2,
    kind: 'product-pipeline-shadow-reconciliation',
    generatedAtUtc: '2026-08-11T16:00:00.000Z',
    identities: {
      shopifyStoreDomain: 'usedcameragear.myshopify.com',
      ebayEnvironment: 'production',
      ebaySellerAccount: 'usedcam-0',
      marketplaceConnectAccount: 'usedcam-0',
    },
    sources: {
      productPipeline: {
        provenance: {
          ...baseProvenance(),
          source: 'productPipeline', method: 'application-ledger-read', attestation: 'runtime-observed',
          subject: { project: 'product-pipeline', shopifyStoreDomain: 'usedcameragear.myshopify.com', ebayEnvironment: 'production', ebaySellerAccount: 'usedcam-0' },
        },
        data: productPipelineData,
      },
      shopify: {
        provenance: {
          ...baseProvenance(),
          source: 'shopify', method: 'direct-api-read', attestation: 'runtime-observed',
          subject: { shopifyStoreDomain: 'usedcameragear.myshopify.com' },
        },
        data: shopifyData,
      },
      ebay: {
        provenance: {
          ...baseProvenance(),
          source: 'ebay', method: 'direct-api-read', attestation: 'runtime-observed',
          subject: { ebayEnvironment: 'production', ebaySellerAccount: 'usedcam-0', marketplaceId: 'EBAY_US' },
        },
        data: ebayData,
      },
      marketplaceConnect: {
        provenance: {
          ...baseProvenance(),
          source: 'marketplaceConnect', method: 'operator-attested-admin-view', attestation: 'operator-attested',
          subject: { shopifyStoreDomain: 'usedcameragear.myshopify.com', marketplaceConnectAccount: 'usedcam-0' },
        },
        data: marketplaceConnectData,
      },
    },
  };
  for (const source of ['productPipeline', 'shopify', 'ebay', 'marketplaceConnect'] as const) {
    refreshReconciliationSource(snapshot, source);
  }
  return { ...snapshot, ...overrides };
}
