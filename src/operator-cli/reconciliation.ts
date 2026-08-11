import fs from 'node:fs/promises';
import path from 'node:path';
import {
  appendAuditRecord,
  DEFAULT_AUDIT_LOG_PATH,
  type AuditEventInput,
} from './audit.js';
import {
  assertPathInsideRoot,
  canonicalJson,
  loadOperatorConfig,
  RESPONSIBILITIES,
  sha256Digest,
  type OperatorConfig,
  type Responsibility,
  validateRepositoryRoot,
} from './config.js';
import {
  computeReconciliationDatasetDigest,
  parseReconciliationSnapshot,
  RECONCILIATION_SOURCES,
  ReconciliationSnapshotError,
  type ReconciliationSnapshot,
  type ReconciliationSource,
  type SourceAvailability,
} from './reconciliation-schema.js';

export {
  computeReconciliationDatasetDigest,
  parseReconciliationSnapshot,
  RECONCILIATION_SOURCES,
  ReconciliationSnapshotError,
};
export type {
  EbayDataset,
  MarketplaceConnectDataset,
  ProductPipelineDataset,
  ReconciliationSnapshot,
  ReconciliationSource,
  ShopifyDataset,
  SourceAvailability,
  SourceBundle,
  SourceProvenance,
} from './reconciliation-schema.js';

export const RECONCILIATION_SNAPSHOT_DIRECTORY = '.local/operator-reconciliation';
export const MAX_RECONCILIATION_SNAPSHOT_BYTES = 4 * 1024 * 1024;
export const MAX_RECONCILIATION_RECORDS_PER_COLLECTION = 5_000;
export const MAX_RECONCILIATION_SOURCE_AGE_MS = 24 * 60 * 60 * 1_000;
export const MAX_RECONCILIATION_SNAPSHOT_AGE_MS = MAX_RECONCILIATION_SOURCE_AGE_MS;
export const MAX_RECONCILIATION_CLOCK_SKEW_MS = 5 * 60 * 1_000;
export const MAX_RECONCILIATION_CROSS_SOURCE_SKEW_MS = 15 * 60 * 1_000;

type SnapshotIdentities = OperatorConfig['identities'];

export type ReconciliationDiscrepancy = {
  code: string;
  severity: 'info' | 'warning' | 'critical';
  responsibility: Responsibility;
  entityType: 'configuration' | 'listing' | 'order' | 'snapshot';
  entityKey: string;
  owner: OperatorConfig['ownership'][Responsibility]['currentOwner'];
  summary: string;
};

export type SourceEvidence = {
  source: ReconciliationSource;
  availability: SourceAvailability;
  method:
    | 'application-ledger-read'
    | 'direct-api-read'
    | 'operator-attested-admin-view';
  attestation: 'runtime-observed' | 'operator-attested';
  apiVersion: string | null;
  capturedAtUtc: string;
  asOfStartUtc: string;
  asOfEndUtc: string;
  freshness: 'fresh' | 'stale' | 'future';
  complete: boolean;
  paginationComplete: boolean;
  pageCount: number;
  recordCount: number | null;
  reportedTotal: number | null;
  terminalCursorDigest: string | null;
  datasetDigest: string | null;
  blockers: string[];
  liveProof: false;
};

export type ResponsibilityEvidence = {
  responsibility: Responsibility;
  owner: OperatorConfig['ownership'][Responsibility]['currentOwner'];
  ownerBasis: 'accepted-marketplace-connect-baseline' | 'operator-configuration';
  state: 'unverified' | 'blocked' | 'consistent-with-supplied-evidence';
  requiredSources: ReconciliationSource[];
  evidenceDigests: string[];
  blockers: string[];
  liveProof: false;
  productionParity: false;
  ownershipTransferred: false;
  canaryReady: false;
};

export type ReconciliationResult = {
  command: 'reconcile';
  status: 'consistent-with-supplied-snapshots' | 'exceptions-found';
  evidenceScope: 'supplied-snapshots-only';
  guarantees: {
    liveProof: false;
    productionParity: false;
    externalNetworkAccess: false;
    externalWrites: 0;
    applicationDatabaseAccess: false;
    historicalBackfill: false;
    orderCreationEligible: false;
  };
  generatedAtUtc: string;
  snapshotAgeMs: number;
  declaredIdentity: SnapshotIdentities;
  ownership: OperatorConfig['ownership'];
  sourceEvidence: SourceEvidence[];
  responsibilityEvidence: ResponsibilityEvidence[];
  counts: {
    productPipelineListings: number;
    productPipelineOrders: number;
    shopifyVariants: number;
    shopifyOrders: number;
    ebayListings: number;
    ebayOrders: number;
    discrepancies: number;
  };
  discrepancies: ReconciliationDiscrepancy[];
  snapshot: { path: string; digest: string };
  resultDigest: string;
  audit: { path: string; sequence: number; recordHash: string };
};

const REQUIRED_SOURCES: Record<Responsibility, readonly ReconciliationSource[]> = {
  listingCreate: RECONCILIATION_SOURCES,
  listingRevise: RECONCILIATION_SOURCES,
  listingEndRelist: RECONCILIATION_SOURCES,
  mapping: RECONCILIATION_SOURCES,
  price: RECONCILIATION_SOURCES,
  inventory: RECONCILIATION_SOURCES,
  orderImport: RECONCILIATION_SOURCES,
  fulfillment: ['shopify', 'ebay', 'marketplaceConnect'],
  feedback: ['ebay', 'marketplaceConnect'],
  reconciliation: RECONCILIATION_SOURCES,
};

const ACCEPTED_MC_BASELINE = new Set<Responsibility>([
  'orderImport',
  'price',
  'inventory',
]);

async function loadReconciliationSnapshot(
  repoRoot: string,
  requestedPath: string,
): Promise<{ snapshot: ReconciliationSnapshot; path: string; digest: string }> {
  const expectedDirectory = path.join(repoRoot, RECONCILIATION_SNAPSHOT_DIRECTORY);
  const requestedAbsolute = assertPathInsideRoot(repoRoot, requestedPath, 'Snapshot path');
  const relativeToExpected = path.relative(expectedDirectory, requestedAbsolute);
  if (
    relativeToExpected === '' ||
    relativeToExpected === '..' ||
    relativeToExpected.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToExpected)
  ) {
    throw new ReconciliationSnapshotError([
      `snapshot file must be beneath ${RECONCILIATION_SNAPSHOT_DIRECTORY}`,
    ]);
  }
  const stat = await fs.lstat(requestedAbsolute).catch(() => null);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
    throw new ReconciliationSnapshotError(['snapshot file must be a regular, non-symlink file']);
  }
  if (stat.size > MAX_RECONCILIATION_SNAPSHOT_BYTES) {
    throw new ReconciliationSnapshotError([
      `snapshot file exceeds the ${MAX_RECONCILIATION_SNAPSHOT_BYTES} byte limit`,
    ]);
  }
  const realPath = await fs.realpath(requestedAbsolute);
  assertPathInsideRoot(repoRoot, realPath, 'Snapshot path');
  const realRelative = path.relative(expectedDirectory, realPath);
  if (
    realRelative === '' ||
    realRelative === '..' ||
    realRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(realRelative)
  ) {
    throw new ReconciliationSnapshotError([
      `snapshot file must resolve beneath ${RECONCILIATION_SNAPSHOT_DIRECTORY}`,
    ]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(realPath, 'utf8')) as unknown;
  } catch {
    throw new ReconciliationSnapshotError(['snapshot file is not valid JSON']);
  }
  const snapshot = parseReconciliationSnapshot(
    parsed,
    MAX_RECONCILIATION_RECORDS_PER_COLLECTION,
  );
  return { snapshot, path: realPath, digest: sha256Digest(snapshot) };
}

function duplicateValues(values: Array<string | null>): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (value === null) continue;
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function uniqueMap<T>(items: T[], key: (item: T) => string | null): Map<string, T> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = key(item);
    if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return new Map(
    items.flatMap((item) => {
      const value = key(item);
      return value !== null && counts.get(value) === 1 ? [[value, item] as const] : [];
    }),
  );
}

function sourceEvidence(snapshot: ReconciliationSnapshot, now: Date): SourceEvidence[] {
  const evidence = RECONCILIATION_SOURCES.map((source): SourceEvidence => {
    const provenance = snapshot.sources[source].provenance;
    const nowMs = now.getTime();
    const futureThresholdMs = nowMs + MAX_RECONCILIATION_CLOCK_SKEW_MS;
    const ageMs = nowMs - Date.parse(provenance.asOfEndUtc);
    const freshness =
      ageMs < -MAX_RECONCILIATION_CLOCK_SKEW_MS
        ? 'future'
        : ageMs > MAX_RECONCILIATION_SOURCE_AGE_MS
          ? 'stale'
          : 'fresh';
    const blockers: string[] = [];
    if (provenance.availability !== 'complete') {
      blockers.push(`source.${source}.${provenance.availability}`);
    }
    if (!provenance.paginationComplete) blockers.push(`source.${source}.pagination-incomplete`);
    if (provenance.pageCount < 1) blockers.push(`source.${source}.terminal-page-unavailable`);
    if (provenance.recordCount === null) blockers.push(`source.${source}.record-count-unavailable`);
    if (provenance.reportedTotal === null) blockers.push(`source.${source}.reported-total-unavailable`);
    if (provenance.terminalCursorDigest === null) {
      blockers.push(`source.${source}.terminal-cursor-proof-unavailable`);
    }
    if (provenance.method === 'direct-api-read' && provenance.apiVersion === null) {
      blockers.push(`source.${source}.api-version-unavailable`);
    }
    if (provenance.datasetDigest === null) blockers.push(`source.${source}.dataset-digest-unavailable`);
    if (
      provenance.reportedTotal !== null &&
      provenance.recordCount !== null &&
      provenance.reportedTotal !== provenance.recordCount
    ) {
      blockers.push(`source.${source}.reported-total-mismatch`);
    }
    if (Date.parse(provenance.capturedAtUtc) > futureThresholdMs) {
      blockers.push(`source.${source}.captured-at-future`);
    }
    if (Date.parse(provenance.queryScope.lowerBoundUtc) > futureThresholdMs) {
      blockers.push(`source.${source}.query-lower-bound-future`);
    }
    if (Date.parse(provenance.queryScope.upperBoundUtc) > futureThresholdMs) {
      blockers.push(`source.${source}.query-upper-bound-future`);
    }
    if (freshness !== 'fresh') blockers.push(`source.${source}.${freshness}`);
    return {
      source,
      availability: provenance.availability,
      method: provenance.method,
      attestation: provenance.attestation,
      apiVersion: provenance.apiVersion,
      capturedAtUtc: provenance.capturedAtUtc,
      asOfStartUtc: provenance.asOfStartUtc,
      asOfEndUtc: provenance.asOfEndUtc,
      freshness,
      complete: blockers.length === 0,
      paginationComplete: provenance.paginationComplete,
      pageCount: provenance.pageCount,
      recordCount: provenance.recordCount,
      reportedTotal: provenance.reportedTotal,
      terminalCursorDigest: provenance.terminalCursorDigest,
      datasetDigest: provenance.datasetDigest,
      blockers,
      liveProof: false,
    };
  });

  const available = evidence.filter((item) => item.availability !== 'unavailable');
  if (available.length > 1) {
    const asOfTimes = available.map((item) => Date.parse(item.asOfEndUtc));
    if (Math.max(...asOfTimes) - Math.min(...asOfTimes) > MAX_RECONCILIATION_CROSS_SOURCE_SKEW_MS) {
      for (const item of available) {
        item.blockers.push('source.cross-source-as-of-skew');
        item.complete = false;
      }
    }
  }
  return evidence;
}

function add(
  target: ReconciliationDiscrepancy[],
  config: OperatorConfig,
  value: Omit<ReconciliationDiscrepancy, 'owner'>,
): void {
  target.push({ ...value, owner: config.ownership[value.responsibility].currentOwner });
}

function compareData(
  snapshot: ReconciliationSnapshot,
  config: OperatorConfig,
  discrepancies: ReconciliationDiscrepancy[],
): void {
  const pp = snapshot.sources.productPipeline.data;
  const shopify = snapshot.sources.shopify.data;
  const ebay = snapshot.sources.ebay.data;
  const mc = snapshot.sources.marketplaceConnect.data;

  for (const responsibility of ACCEPTED_MC_BASELINE) {
    const declaration = config.ownership[responsibility];
    if (
      declaration.currentOwner !== 'marketplace-connect' ||
      declaration.productPipelineAccess !== 'read-only'
    ) {
      add(discrepancies, config, {
        code: `ownership.${responsibility}.baseline-mismatch`, severity: 'critical',
        responsibility, entityType: 'configuration', entityKey: responsibility,
        summary: 'Accepted baseline requires Marketplace Connect ownership and ProductPipeline read-only access.',
      });
    }
  }
  for (const responsibility of RESPONSIBILITIES) {
    if (config.ownership[responsibility].currentOwner === 'unverified') {
      add(discrepancies, config, {
        code: `ownership.${responsibility}.unverified`, severity: 'warning', responsibility,
        entityType: 'configuration', entityKey: responsibility,
        summary: 'Ownership is not established by operator configuration; observations never transfer it.',
      });
    }
  }

  const settingCounts = new Map<Responsibility, number>();
  for (const setting of mc.settings) {
    settingCounts.set(setting.responsibility, (settingCounts.get(setting.responsibility) ?? 0) + 1);
    if (!setting.enabled) {
      add(discrepancies, config, {
        code: `marketplace-connect.${setting.responsibility}.not-observed-enabled`, severity: 'critical',
        responsibility: setting.responsibility, entityType: 'configuration', entityKey: setting.responsibility,
        summary: 'Operator-attested observation does not match the accepted incumbent-owner baseline.',
      });
    }
  }
  for (const responsibility of ACCEPTED_MC_BASELINE) {
    const count = settingCounts.get(responsibility) ?? 0;
    if (count !== 1) {
      add(discrepancies, config, {
        code: count === 0
          ? `marketplace-connect.${responsibility}.observation-missing`
          : `marketplace-connect.${responsibility}.observation-duplicate`,
        severity: 'critical', responsibility, entityType: 'configuration', entityKey: responsibility,
        summary: 'Exactly one operator-attested Marketplace Connect setting observation is required.',
      });
    }
  }

  const duplicateChecks: Array<{
    code: string; values: Array<string | null>; responsibility: Responsibility; summary: string;
  }> = [
    { code: 'listing.duplicate-local-shopify-variant', values: pp.listings.map((x) => x.shopifyVariantGid), responsibility: 'mapping', summary: 'Multiple local rows claim the same Shopify variant.' },
    { code: 'listing.duplicate-local-ebay-listing', values: pp.listings.map((x) => x.ebayListingId), responsibility: 'mapping', summary: 'Multiple local rows claim the same eBay listing.' },
    { code: 'listing.duplicate-local-sku', values: pp.listings.map((x) => x.sku), responsibility: 'mapping', summary: 'ProductPipeline repeats a listing SKU.' },
    { code: 'listing.duplicate-shopify-variant', values: shopify.variants.map((x) => x.shopifyVariantGid), responsibility: 'reconciliation', summary: 'Shopify repeats a stable variant identity.' },
    { code: 'listing.duplicate-shopify-sku', values: shopify.variants.map((x) => x.sku), responsibility: 'mapping', summary: 'Shopify repeats a SKU; SKU joins are withheld to prevent silent overwrite.' },
    { code: 'listing.duplicate-ebay-listing', values: ebay.listings.map((x) => x.listingId), responsibility: 'reconciliation', summary: 'eBay repeats a stable listing identity.' },
    { code: 'listing.duplicate-ebay-offer', values: ebay.listings.map((x) => x.offerId), responsibility: 'reconciliation', summary: 'eBay repeats a stable offer identity.' },
    { code: 'listing.duplicate-ebay-inventory-sku', values: ebay.listings.map((x) => x.inventoryItemSku), responsibility: 'mapping', summary: 'eBay repeats an inventory SKU; SKU joins are withheld to prevent silent overwrite.' },
    { code: 'order.duplicate-ebay-source-id', values: ebay.orders.map((x) => x.ebayOrderId), responsibility: 'orderImport', summary: 'eBay repeats an order identity.' },
    { code: 'order.duplicate-local-source-id', values: pp.orders.map((x) => x.ebayOrderId), responsibility: 'orderImport', summary: 'ProductPipeline repeats an eBay order identity.' },
    { code: 'order.duplicate-shopify-order-id', values: shopify.orders.map((x) => x.shopifyOrderGid), responsibility: 'reconciliation', summary: 'Shopify repeats a stable order identity.' },
  ];
  for (const check of duplicateChecks) {
    for (const duplicate of duplicateValues(check.values)) {
      add(discrepancies, config, {
        code: check.code, severity: 'critical', responsibility: check.responsibility,
        entityType: check.code.startsWith('order.') ? 'order' : 'listing', entityKey: duplicate,
        summary: check.summary,
      });
    }
  }

  const ppComplete = snapshot.sources.productPipeline.provenance.availability === 'complete';
  const shopifyComplete = snapshot.sources.shopify.provenance.availability === 'complete';
  const ebayComplete = snapshot.sources.ebay.provenance.availability === 'complete';
  const shopifyByVariant = uniqueMap(shopify.variants, (x) => x.shopifyVariantGid);
  const ebayByListing = uniqueMap(ebay.listings, (x) => x.listingId);
  const shopifyBySku = uniqueMap(shopify.variants, (x) => x.sku);
  const ebayBySku = uniqueMap(ebay.listings, (x) => x.inventoryItemSku);

  if (ppComplete && shopifyComplete && ebayComplete) {
    for (const local of pp.listings) {
      if (local.shopifyVariantGid === null) {
        add(discrepancies, config, { code: 'listing.local-variant-identity-missing', severity: 'warning', responsibility: 'mapping', entityType: 'listing', entityKey: local.sku, summary: 'Local mapping lacks a stable Shopify variant GID.' });
      } else {
        const remote = shopifyByVariant.get(local.shopifyVariantGid);
        if (!remote) add(discrepancies, config, { code: 'listing.local-shopify-orphan', severity: 'critical', responsibility: 'mapping', entityType: 'listing', entityKey: local.shopifyVariantGid, summary: 'Local link has no matching Shopify variant.' });
        else {
          const productGid = local.shopifyProductId.startsWith('gid://') ? local.shopifyProductId : `gid://shopify/Product/${local.shopifyProductId}`;
          if (remote.shopifyProductGid !== productGid) add(discrepancies, config, { code: 'listing.local-shopify-product-mismatch', severity: 'critical', responsibility: 'mapping', entityType: 'listing', entityKey: local.shopifyVariantGid, summary: 'Local product identity and Shopify variant parent do not agree.' });
          if (remote.sku !== local.sku) add(discrepancies, config, { code: 'listing.local-shopify-sku-mismatch', severity: 'warning', responsibility: 'mapping', entityType: 'listing', entityKey: local.shopifyVariantGid, summary: 'Local and Shopify SKUs do not agree.' });
        }
      }
      if (local.ebayListingId === null) {
        add(discrepancies, config, { code: 'listing.local-ebay-link-missing', severity: 'warning', responsibility: 'mapping', entityType: 'listing', entityKey: local.sku, summary: 'Local row has no stable eBay listing ID.' });
      } else {
        const remote = ebayByListing.get(local.ebayListingId);
        if (!remote) add(discrepancies, config, { code: 'listing.local-ebay-orphan', severity: 'critical', responsibility: 'mapping', entityType: 'listing', entityKey: local.ebayListingId, summary: 'Local link has no matching eBay listing.' });
        else {
          if (local.ebayInventoryItemSku !== null && local.ebayInventoryItemSku !== remote.inventoryItemSku) add(discrepancies, config, { code: 'listing.inventory-item-sku-mismatch', severity: 'warning', responsibility: 'mapping', entityType: 'listing', entityKey: local.ebayListingId, summary: 'Local and eBay inventory SKUs do not agree.' });
          if (local.ebayOfferId !== null && local.ebayOfferId !== remote.offerId) add(discrepancies, config, { code: 'listing.offer-id-mismatch', severity: 'warning', responsibility: 'mapping', entityType: 'listing', entityKey: local.ebayListingId, summary: 'Local and eBay offer IDs do not agree.' });
          const expectedStatus = local.status === 'active' ? 'published' : local.status === 'ended' ? 'ended' : local.status === 'draft' ? 'unpublished' : null;
          if (expectedStatus !== null && remote.status !== expectedStatus) add(discrepancies, config, { code: 'listing.status-mismatch', severity: 'warning', responsibility: 'listingRevise', entityType: 'listing', entityKey: local.ebayListingId, summary: 'ProductPipeline and eBay listing statuses do not agree.' });
        }
      }
    }
  }

  if (shopifyComplete && ebayComplete) {
    for (const [sku, shopifyVariant] of shopifyBySku) {
      const ebayListing = ebayBySku.get(sku);
      if (!ebayListing) continue;
      if (shopifyVariant.priceMinor !== ebayListing.priceMinor || shopifyVariant.currency !== ebayListing.currency) add(discrepancies, config, { code: 'price.observed-difference', severity: 'warning', responsibility: 'price', entityType: 'listing', entityKey: sku, summary: 'Shopify and eBay prices differ; observation does not authorize a write.' });
      if (shopifyVariant.inventoryQuantity !== ebayListing.availableQuantity) add(discrepancies, config, { code: 'inventory.observed-difference', severity: 'warning', responsibility: 'inventory', entityType: 'listing', entityKey: sku, summary: 'Shopify and eBay quantities differ; observation does not authorize a write.' });
    }
  }

  if (ppComplete && shopifyComplete && ebayComplete) {
    const ebayOrderIds = new Set(ebay.orders.map((x) => x.ebayOrderId));
    const shopifyByEbay = new Map<string, typeof shopify.orders>();
    for (const order of shopify.orders) {
      if (order.ebayOrderId === null) continue;
      const matches = shopifyByEbay.get(order.ebayOrderId) ?? [];
      matches.push(order);
      shopifyByEbay.set(order.ebayOrderId, matches);
      if (!ebayOrderIds.has(order.ebayOrderId)) add(discrepancies, config, { code: 'order.shopify-source-not-in-ebay-snapshot', severity: 'warning', responsibility: 'reconciliation', entityType: 'order', entityKey: order.shopifyOrderGid, summary: 'Shopify references an eBay order absent from the bounded eBay dataset.' });
    }
    const localByEbay = uniqueMap(pp.orders, (x) => x.ebayOrderId);
    const shopifyByGid = uniqueMap(shopify.orders, (x) => x.shopifyOrderGid);
    for (const local of pp.orders) {
      if (!ebayOrderIds.has(local.ebayOrderId)) add(discrepancies, config, { code: 'order.local-ebay-orphan', severity: 'warning', responsibility: 'reconciliation', entityType: 'order', entityKey: local.ebayOrderId, summary: 'Local order observation is absent from the bounded eBay dataset.' });
      if (local.state === 'mapped' && local.shopifyOrderGid === null) add(discrepancies, config, { code: 'order.local-mapped-without-shopify-id', severity: 'critical', responsibility: 'reconciliation', entityType: 'order', entityKey: local.ebayOrderId, summary: 'Local mapped state lacks a stable Shopify order GID.' });
      if (local.shopifyOrderGid !== null) {
        const linked = shopifyByGid.get(local.shopifyOrderGid);
        if (!linked) add(discrepancies, config, { code: 'order.local-shopify-orphan', severity: 'critical', responsibility: 'reconciliation', entityType: 'order', entityKey: local.ebayOrderId, summary: 'Local mapping points to an absent Shopify order.' });
        else if (linked.ebayOrderId !== local.ebayOrderId) add(discrepancies, config, { code: 'order.local-shopify-link-mismatch', severity: 'critical', responsibility: 'reconciliation', entityType: 'order', entityKey: local.ebayOrderId, summary: 'Local and Shopify order-link identities do not agree.' });
      }
    }
    for (const order of ebay.orders) {
      const matches = shopifyByEbay.get(order.ebayOrderId) ?? [];
      if (matches.length === 0) add(discrepancies, config, { code: 'order.no-shopify-link-observed', severity: 'warning', responsibility: 'orderImport', entityType: 'order', entityKey: order.ebayOrderId, summary: 'No Shopify link is present; this is an incumbent-owned exception, never an import candidate.' });
      if (matches.length > 1) add(discrepancies, config, { code: 'order.duplicate-shopify-links', severity: 'critical', responsibility: 'orderImport', entityType: 'order', entityKey: order.ebayOrderId, summary: 'More than one Shopify order references the same eBay order.' });
      for (const match of matches) {
        if (match.importOwner === 'product-pipeline') add(discrepancies, config, { code: 'order.product-pipeline-import-observed', severity: 'critical', responsibility: 'orderImport', entityType: 'order', entityKey: order.ebayOrderId, summary: 'An order is attributed to ProductPipeline during writer quarantine.' });
        if (match.importOwner === 'unknown') add(discrepancies, config, { code: 'order.import-owner-unverified', severity: 'warning', responsibility: 'orderImport', entityType: 'order', entityKey: order.ebayOrderId, summary: 'Shopify order import ownership is not established.' });
      }
      if (!localByEbay.has(order.ebayOrderId)) add(discrepancies, config, { code: 'order.missing-local-observation', severity: 'info', responsibility: 'reconciliation', entityType: 'order', entityKey: order.ebayOrderId, summary: 'eBay order is not represented in ProductPipeline observations.' });
    }
  }
}

function responsibilityEvidence(
  config: OperatorConfig,
  sources: SourceEvidence[],
  discrepancies: ReconciliationDiscrepancy[],
): ResponsibilityEvidence[] {
  const sourceByName = new Map(sources.map((item) => [item.source, item]));
  return RESPONSIBILITIES.map((responsibility) => {
    const requiredSources = [...REQUIRED_SOURCES[responsibility]];
    const blockers = requiredSources.flatMap((source) => sourceByName.get(source)?.blockers ?? [`source.${source}.missing`]);
    blockers.push(...discrepancies.filter((item) => item.responsibility === responsibility).map((item) => item.code));
    const declaration = config.ownership[responsibility];
    const baselineAccepted = ACCEPTED_MC_BASELINE.has(responsibility);
    if (baselineAccepted && declaration.currentOwner !== 'marketplace-connect') blockers.push(`ownership.${responsibility}.baseline-not-accepted`);
    if (!baselineAccepted && declaration.currentOwner === 'unverified') blockers.push(`ownership.${responsibility}.unverified`);
    if (responsibility !== 'reconciliation') {
      blockers.push(`responsibility.${responsibility}.model-coverage-incomplete`);
    }
    const uniqueBlockers = [...new Set(blockers)].sort();
    const evidenceDigests = requiredSources.flatMap((source) => {
      const digest = sourceByName.get(source)?.datasetDigest;
      return digest ? [digest] : [];
    });
    return {
      responsibility,
      owner: declaration.currentOwner,
      ownerBasis: baselineAccepted ? 'accepted-marketplace-connect-baseline' : 'operator-configuration',
      state: declaration.currentOwner === 'unverified'
        ? 'unverified'
        : uniqueBlockers.length > 0
          ? 'blocked'
          : 'consistent-with-supplied-evidence',
      requiredSources,
      evidenceDigests,
      blockers: uniqueBlockers,
      liveProof: false,
      productionParity: false,
      ownershipTransferred: false,
      canaryReady: false,
    };
  });
}

function compareSnapshots(
  snapshot: ReconciliationSnapshot,
  config: OperatorConfig,
  now: Date,
): Omit<ReconciliationResult, 'snapshot' | 'resultDigest' | 'audit'> {
  const discrepancies: ReconciliationDiscrepancy[] = [];
  const sources = sourceEvidence(snapshot, now);
  if (
    Date.parse(snapshot.generatedAtUtc) >
    now.getTime() + MAX_RECONCILIATION_CLOCK_SKEW_MS
  ) {
    add(discrepancies, config, {
      code: 'snapshot.generated-at-future',
      severity: 'critical',
      responsibility: 'reconciliation',
      entityType: 'snapshot',
      entityKey: 'snapshot',
      summary: 'Snapshot generation time is beyond the permitted clock skew.',
    });
  }
  for (const evidence of sources) {
    for (const blocker of evidence.blockers) {
      add(discrepancies, config, {
        code: blocker, severity: 'critical', responsibility: 'reconciliation',
        entityType: 'snapshot', entityKey: evidence.source,
        summary: `Source evidence is not readiness-eligible: ${blocker}.`,
      });
    }
  }
  compareData(snapshot, config, discrepancies);
  discrepancies.sort((a, b) => `${a.code}\u0000${a.entityKey}`.localeCompare(`${b.code}\u0000${b.entityKey}`));
  const responsibilities = responsibilityEvidence(config, sources, discrepancies);
  return {
    command: 'reconcile',
    status: discrepancies.length === 0 && responsibilities.every((item) => item.state === 'consistent-with-supplied-evidence')
      ? 'consistent-with-supplied-snapshots'
      : 'exceptions-found',
    evidenceScope: 'supplied-snapshots-only',
    guarantees: { liveProof: false, productionParity: false, externalNetworkAccess: false, externalWrites: 0, applicationDatabaseAccess: false, historicalBackfill: false, orderCreationEligible: false },
    generatedAtUtc: snapshot.generatedAtUtc,
    snapshotAgeMs: now.getTime() - Date.parse(snapshot.generatedAtUtc),
    declaredIdentity: snapshot.identities,
    ownership: config.ownership,
    sourceEvidence: sources,
    responsibilityEvidence: responsibilities,
    counts: {
      productPipelineListings: snapshot.sources.productPipeline.data.listings.length,
      productPipelineOrders: snapshot.sources.productPipeline.data.orders.length,
      shopifyVariants: snapshot.sources.shopify.data.variants.length,
      shopifyOrders: snapshot.sources.shopify.data.orders.length,
      ebayListings: snapshot.sources.ebay.data.listings.length,
      ebayOrders: snapshot.sources.ebay.data.orders.length,
      discrepancies: discrepancies.length,
    },
    discrepancies,
  };
}

function auditChecks(
  snapshot: ReconciliationSnapshot,
  snapshotDigest: string,
  resultDigest: string,
  hasExceptions: boolean,
): AuditEventInput['checks'] {
  return [
    { id: 'reconciliation.snapshot-v2-valid', result: 'pass' },
    { id: 'reconciliation.identity-match', result: 'pass' },
    { id: 'safety.read-only', result: 'pass' },
    { id: 'safety.external-writes-zero', result: 'pass' },
    { id: 'safety.historical-backfill-disabled', result: 'pass' },
    { id: 'safety.order-creation-ineligible', result: 'pass' },
    ...RECONCILIATION_SOURCES.map((source): AuditEventInput['checks'][number] => ({
      // Audit check IDs are intentionally normalized; the result still carries the exact source key.
      id: snapshot.sources[source].provenance.datasetDigest
        ? `reconciliation.${source.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)}-dataset-${snapshot.sources[source].provenance.datasetDigest!.slice('sha256:'.length)}`
        : `reconciliation.${source.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)}-dataset-unavailable`,
      result: snapshot.sources[source].provenance.availability === 'complete' ? 'pass' : 'block',
    })),
    { id: `reconciliation.snapshot-digest-${snapshotDigest.slice('sha256:'.length)}`, result: 'pass' },
    { id: `reconciliation.result-digest-${resultDigest.slice('sha256:'.length)}`, result: 'pass' },
    { id: 'reconciliation.exceptions-absent', result: hasExceptions ? 'block' : 'pass' },
  ];
}

async function appendDenial(repoRoot: string, config: OperatorConfig | null, checkId: string): Promise<void> {
  await appendAuditRecord(repoRoot, DEFAULT_AUDIT_LOG_PATH, {
    command: 'reconcile', lane: config?.lane ?? 'unavailable', mode: config?.mode ?? 'unavailable', outcome: 'denied',
    configDigest: config ? sha256Digest(config) : null,
    target: config?.identities ?? { shopifyStoreDomain: null, ebayEnvironment: null, ebaySellerAccount: null, marketplaceConnectAccount: null },
    ownershipDigest: config ? sha256Digest(config.ownership) : null,
    checks: [{ id: checkId, result: 'deny' }],
  });
}

export async function runSnapshotReconciliation(options: {
  repoRoot: string;
  configPath: string;
  snapshotPath: string;
  now?: () => Date;
  createRunId?: () => string;
}): Promise<ReconciliationResult> {
  const repoRoot = await validateRepositoryRoot(options.repoRoot);
  let loadedConfig;
  try {
    loadedConfig = await loadOperatorConfig(repoRoot, options.configPath);
  } catch (error) {
    try { await appendDenial(repoRoot, null, 'config.schema-invalid'); }
    catch (auditError) {
      const reason = error instanceof Error ? error.message : 'Operator config denied';
      const auditReason = auditError instanceof Error ? auditError.message : 'unknown audit failure';
      throw new Error(`${reason}; denial audit failed: ${auditReason}`);
    }
    throw error;
  }
  let loadedSnapshot;
  try {
    loadedSnapshot = await loadReconciliationSnapshot(repoRoot, options.snapshotPath);
  } catch (error) {
    try { await appendDenial(repoRoot, loadedConfig.config, 'reconciliation.snapshot-invalid'); }
    catch (auditError) {
      const reason = error instanceof Error ? error.message : 'Snapshot denied';
      const auditReason = auditError instanceof Error ? auditError.message : 'unknown audit failure';
      throw new Error(`${reason}; denial audit failed: ${auditReason}`);
    }
    throw error;
  }
  if (canonicalJson(loadedSnapshot.snapshot.identities) !== canonicalJson(loadedConfig.config.identities)) {
    try { await appendDenial(repoRoot, loadedConfig.config, 'reconciliation.identity-mismatch'); }
    catch (auditError) {
      const reason = auditError instanceof Error ? auditError.message : 'unknown audit failure';
      throw new Error(`Snapshot identity does not match operator config; denial audit failed: ${reason}`);
    }
    throw new ReconciliationSnapshotError(['snapshot identity does not match operator config']);
  }
  const core = compareSnapshots(loadedSnapshot.snapshot, loadedConfig.config, (options.now ?? (() => new Date()))());
  const snapshotPath = path.relative(repoRoot, loadedSnapshot.path);
  const resultDigest = sha256Digest({ ...core, snapshot: { path: snapshotPath, digest: loadedSnapshot.digest } });
  const auditRecord = await appendAuditRecord(repoRoot, loadedConfig.config.audit.logPath, {
    command: 'reconcile', lane: loadedConfig.config.lane, mode: loadedConfig.config.mode,
    outcome: core.status === 'consistent-with-supplied-snapshots' ? 'passed' : 'blocked',
    configDigest: loadedConfig.digest, target: loadedConfig.config.identities,
    ownershipDigest: sha256Digest(loadedConfig.config.ownership),
    checks: auditChecks(
      loadedSnapshot.snapshot,
      loadedSnapshot.digest,
      resultDigest,
      core.status === 'exceptions-found',
    ),
  }, { now: options.now, createRunId: options.createRunId });
  return {
    ...core,
    snapshot: { path: snapshotPath, digest: loadedSnapshot.digest },
    resultDigest,
    audit: { path: loadedConfig.config.audit.logPath, sequence: auditRecord.sequence, recordHash: auditRecord.recordHash },
  };
}
