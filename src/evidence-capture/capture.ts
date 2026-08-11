import { timingSafeEqual } from 'node:crypto';
import {
  buildEvidencePayload,
  createEvidenceArtifactSigner,
  readEvidenceArtifact,
  type EvidenceArtifact,
  type EvidenceSource,
  verifyEvidenceArtifact,
  writeEvidenceArtifact,
} from './artifact.js';
import {
  EVIDENCE_CAPTURE_CONFIG_RELATIVE_PATH,
  loadEvidenceCaptureConfig,
  sha256Digest,
  type LoadedEvidenceCaptureConfig,
} from './config.js';
import {
  createEbayEvidenceCollector,
  createEbayOrderWindow,
  EBAY_READ_SCOPES,
  type EbayInventoryEvidence,
  type EbayOrderEvidence,
  type EbayRequestEvidence,
} from './ebay.js';
import {
  createEbayNetworkTransport,
  createShopifyNetworkDispatcher,
  inspectEvidenceAuthorityAvailability,
  type EvidenceFetch,
} from './network.js';
import {
  captureShopifyAuthoritativeEvidence,
  SHOPIFY_ADMIN_API_VERSION,
  type ShopifyAuthoritativeEvidence,
} from './shopify.js';

export type CaptureSource = Extract<EvidenceSource, 'shopify' | 'ebay'>;

export class EvidenceCaptureCommandError extends Error {
  readonly code:
    | 'source-denied'
    | 'scope-confirmation-denied'
    | 'build-identity-denied'
    | 'window-denied'
    | 'record-limit-exceeded'
    | 'artifact-path-denied'
    | 'artifact-schema-denied';

  constructor(code: EvidenceCaptureCommandError['code']) {
    super(`Evidence capture command failed closed: ${code}`);
    this.name = 'EvidenceCaptureCommandError';
    this.code = code;
  }
}

export type EvidenceCapturePreflight = Readonly<{
  schemaVersion: 1;
  command: 'preflight';
  status: 'locally-ready' | 'blocked';
  lane: 'sandbox' | 'production-shadow';
  mode: 'authoritative-read-capture';
  scopeDigest: `sha256:${string}`;
  configDigest: `sha256:${string}`;
  configPath: typeof EVIDENCE_CAPTURE_CONFIG_RELATIVE_PATH;
  networkPerformed: false;
  remoteAuthorityVerified: false;
  runtimeBuild: Readonly<{
    configuredCommit: string;
    headCommitMatches: boolean;
    collectorTreeClean: boolean;
  }>;
  historicalVerificationContextArchived: false;
  externalWrites: 0;
  historicalBackfill: false;
  sourceReadiness: Readonly<{
    shopify: boolean;
    ebay: boolean;
  }>;
  authorityPresence: Readonly<{
    shopifyAccessPresent: boolean;
    ebayAccessPresent: boolean;
    ebayExpiryMetadataPresent: boolean;
    ebayScopeMetadataPresent: boolean;
    signingAuthorityPresent: boolean;
  }>;
  blockers: readonly string[];
  cutoverBlockers: readonly string[];
}>;

export type EvidenceCaptureRuntimeBuildIdentity = Readonly<{
  headCommit: string;
  collectorTreeClean: boolean;
}>;

export type ShopifyCaptureEvidence = Readonly<{
  schemaVersion: 1;
  kind: 'shopify-authoritative-read-capture';
  identity: ShopifyAuthoritativeEvidence['identity'];
  variants: ShopifyAuthoritativeEvidence['variants'];
  orders: ShopifyAuthoritativeEvidence['orders'];
  provenance: ShopifyAuthoritativeEvidence['provenance'];
}>;

type SafeEbayInventoryEvidence = Omit<EbayInventoryEvidence, 'safeguards'> & Readonly<{
  safeguards: Readonly<{
    getOnly: true;
    oauthRefreshAbsent: true;
    externalWritesSupported: false;
  }>;
}>;

type SafeEbayOrderEvidence = Omit<EbayOrderEvidence, 'safeguards' | 'rawInclusiveRecordCount'>
  & Readonly<{
    safeguards: Readonly<{
      getOnly: true;
      oauthRefreshAbsent: true;
      externalWritesSupported: false;
      orderFieldsMinimized: true;
    }>;
    inclusiveRecordCount: number;
  }>;

export type EbayCaptureEvidence = Readonly<{
  schemaVersion: 1;
  kind: 'ebay-authoritative-read-capture';
  identity: Readonly<{ userId: string; registrationMarketplaceId: string }>;
  inventory: SafeEbayInventoryEvidence;
  orders: SafeEbayOrderEvidence;
}>;

export type SourceCaptureEvidence = ShopifyCaptureEvidence | EbayCaptureEvidence;

export type EvidenceCollectionResult = Readonly<{
  schemaVersion: 1;
  command: 'collect';
  status: 'captured';
  source: CaptureSource;
  lane: 'sandbox' | 'production-shadow';
  generatedAtUtc: string;
  orderWindow: Readonly<{ startUtc: string; endUtc: string }>;
  scopeDigest: `sha256:${string}`;
  configDigest: `sha256:${string}`;
  artifact: Readonly<{
    relativePath: string;
    digest: `sha256:${string}`;
  }>;
  counts: Readonly<{
    primary: number;
    secondary: number;
    orders: number;
  }>;
  networkReadsPerformed: true;
  externalWrites: 0;
  historicalBackfill: false;
  productionParity: false;
  cutoverReady: false;
  historicalVerificationContextArchived: false;
}>;

export type EvidenceVerificationResult = Readonly<{
  schemaVersion: 1;
  command: 'verify';
  status: 'verified';
  source: CaptureSource;
  generatedAtUtc: string;
  artifactRelativePath: string;
  artifactDigest: `sha256:${string}`;
  scopeDigest: `sha256:${string}`;
  configDigest: `sha256:${string}`;
  counts: Readonly<{
    primary: number;
    secondary: number;
    orders: number;
  }>;
  signatureValid: true;
  sourceSchemaValid: true;
  freshness: 'fresh' | 'stale' | 'future';
  currentReadEvidence: boolean;
  parityUseAllowed: false;
  signedCollectorBuildCommit: string;
  currentCheckoutMatchesSignedBuild: boolean;
  currentCollectorTreeClean: boolean;
  historicalVerificationContextArchived: false;
  externalWrites: 0;
  historicalBackfill: false;
  productionParity: false;
  cutoverReady: false;
}>;

const MAX_ORDER_WINDOW_MS = 168 * 60 * 60 * 1_000;
const MAX_ORDER_WINDOW_LAG_MS = 15 * 60 * 1_000;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const GID_PATTERNS = Object.freeze({
  shop: /^gid:\/\/shopify\/Shop\/[A-Za-z0-9_-]+$/,
  app: /^gid:\/\/shopify\/App\/[A-Za-z0-9_-]+$/,
  product: /^gid:\/\/shopify\/Product\/[A-Za-z0-9_-]+$/,
  variant: /^gid:\/\/shopify\/ProductVariant\/[A-Za-z0-9_-]+$/,
  inventoryItem: /^gid:\/\/shopify\/InventoryItem\/[A-Za-z0-9_-]+$/,
  inventoryLevel: /^gid:\/\/shopify\/InventoryLevel\/[A-Za-z0-9_?=&-]+$/,
  location: /^gid:\/\/shopify\/Location\/[A-Za-z0-9_-]+$/,
  order: /^gid:\/\/shopify\/Order\/[A-Za-z0-9_-]+$/,
});
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+\/-]{0,511}$/;
const BUILD_COMMIT = /^[a-f0-9]{40}$/;
const EMBEDDED_FORBIDDEN_TEXT =
  /(?:Bearer\s+|shpat_|shpca_|shppa_|gh[pousr]_|sk-[A-Za-z0-9_-]{10,}|v\^1\.|-----BEGIN [A-Z ]*PRIVATE KEY-----|[^\s@]+@[^\s@]+\.[^\s@]+)/i;

function deny(code: EvidenceCaptureCommandError['code']): never {
  throw new EvidenceCaptureCommandError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((entry, index) => entry === expected[index]);
}

function canonicalUtc(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function safeString(value: unknown, pattern: RegExp = SAFE_TEXT): value is string {
  return typeof value === 'string'
    && pattern.test(value)
    && value.trim() === value
    && !EMBEDDED_FORBIDDEN_TEXT.test(value);
}

function nullableSafeString(value: unknown): value is string | null {
  return value === null || safeString(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function exactDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

function uniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function equalDigest(left: string, right: string): boolean {
  if (!DIGEST_PATTERN.test(left) || !DIGEST_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function validateOrderWindow(input: {
  startUtc: string;
  endUtc: string;
  nowUtc: string;
}): Readonly<{ startUtc: string; endUtc: string }> {
  if (!canonicalUtc(input.startUtc) || !canonicalUtc(input.endUtc) || !canonicalUtc(input.nowUtc)) {
    deny('window-denied');
  }
  const start = Date.parse(input.startUtc);
  const end = Date.parse(input.endUtc);
  const now = Date.parse(input.nowUtc);
  if (
    start >= end
    || end > now
    || end - start > MAX_ORDER_WINDOW_MS
    || start < now - MAX_ORDER_WINDOW_MS
    || now - end > MAX_ORDER_WINDOW_LAG_MS
  ) deny('window-denied');
  return Object.freeze({ startUtc: input.startUtc, endUtc: input.endUtc });
}

function parseSource(value: string): CaptureSource {
  if (value !== 'shopify' && value !== 'ebay') deny('source-denied');
  return value;
}

function validRuntimeBuild(
  runtimeBuild: EvidenceCaptureRuntimeBuildIdentity,
  loaded: LoadedEvidenceCaptureConfig,
): boolean {
  return exactKeys(runtimeBuild, ['headCommit', 'collectorTreeClean'])
    && safeString(runtimeBuild.headCommit, BUILD_COMMIT)
    && runtimeBuild.headCommit === loaded.config.collector.buildCommit
    && runtimeBuild.collectorTreeClean === true;
}

export function runEvidenceCapturePreflight(input: {
  repositoryRoot: string;
  environment: Readonly<Record<string, string | undefined>>;
  now: () => Date;
  runtimeBuild: EvidenceCaptureRuntimeBuildIdentity;
}): EvidenceCapturePreflight {
  const loaded = loadEvidenceCaptureConfig({
    repositoryRoot: input.repositoryRoot,
    requestedConfigPath: EVIDENCE_CAPTURE_CONFIG_RELATIVE_PATH,
  });
  const authorityPresence = inspectEvidenceAuthorityAvailability(input.environment);
  const headCommitMatches = safeString(input.runtimeBuild.headCommit, BUILD_COMMIT)
    && input.runtimeBuild.headCommit === loaded.config.collector.buildCommit;
  const collectorTreeClean = input.runtimeBuild.collectorTreeClean === true;
  const runtimeBuildValid = validRuntimeBuild(input.runtimeBuild, loaded);
  const now = input.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) deny('window-denied');
  const nowUtc = now.toISOString();
  let signingValid = false;
  let shopifyAuthorityValid = false;
  let ebayAuthorityValid = false;
  const neverFetch: EvidenceFetch = async () => {
    throw new Error('preflight network boundary was invoked');
  };
  if (runtimeBuildValid) {
    try {
      createEvidenceArtifactSigner({ loaded, environment: input.environment });
      signingValid = true;
    } catch {
      // The safe result reports only validity, never the supplied authority material.
    }
    try {
      createShopifyNetworkDispatcher({
        loaded,
        environment: input.environment,
        fetch: neverFetch,
      });
      shopifyAuthorityValid = true;
    } catch {
      // Local structural authority validation failed closed without a request.
    }
    try {
      const { transport, authorization } = createEbayNetworkTransport({
        loaded,
        environment: input.environment,
        fetch: neverFetch,
        nowUtc,
      });
      createEbayEvidenceCollector({
        environment: loaded.config.identities.ebayEnvironment,
        capturedAtUtc: nowUtc,
        expectedIdentity: {
          userId: loaded.config.identities.ebayUserId,
          registrationMarketplaceId: loaded.config.identities.ebayRegistrationMarketplaceId,
        },
        authorization,
        limits: ebayCollectorLimits(loaded),
      }, transport);
      ebayAuthorityValid = true;
    } catch {
      // Expired, near-expiry, malformed, or overlong authority is locally denied.
    }
  }
  const sourceReadiness = Object.freeze({
    shopify: shopifyAuthorityValid && signingValid && runtimeBuildValid,
    ebay: ebayAuthorityValid && signingValid && runtimeBuildValid,
  });
  const blockers: string[] = [];
  if (!headCommitMatches) blockers.push('Configured collector commit does not match the current Git HEAD');
  if (!collectorTreeClean) blockers.push('Collector-relevant Git paths are not clean');
  if (!sourceReadiness.shopify) blockers.push('Shopify read and signing authority are not both present');
  if (!sourceReadiness.ebay) {
    blockers.push('eBay read, exact readonly-scope metadata, expiry metadata, and signing authority are not all locally valid');
  }
  return Object.freeze({
    schemaVersion: 1,
    command: 'preflight',
    status: blockers.length === 0 ? 'locally-ready' : 'blocked',
    lane: loaded.config.lane,
    mode: loaded.config.mode,
    scopeDigest: loaded.scopeDigest,
    configDigest: loaded.configDigest,
    configPath: EVIDENCE_CAPTURE_CONFIG_RELATIVE_PATH,
    networkPerformed: false,
    remoteAuthorityVerified: false,
    runtimeBuild: Object.freeze({
      configuredCommit: loaded.config.collector.buildCommit,
      headCommitMatches,
      collectorTreeClean,
    }),
    historicalVerificationContextArchived: false,
    externalWrites: 0,
    historicalBackfill: false,
    sourceReadiness,
    authorityPresence,
    blockers: Object.freeze(blockers),
    cutoverBlockers: Object.freeze([
      'No archived immutable config, public key, and collector-build context preserves verification after context changes',
      'Local preflight does not prove remote authority, source reachability, parity, or cutover readiness',
    ]),
  });
}

function ebayCollectorLimits(loaded: LoadedEvidenceCaptureConfig) {
  const perResponse = Math.min(16 * 1024 * 1024, loaded.config.limits.maxResponseBytes);
  return Object.freeze({
    timeoutMs: loaded.config.limits.requestTimeoutMs,
    maxResponseBytes: perResponse,
    maxTotalResponseBytes: Math.min(
      64 * 1024 * 1024,
      perResponse * Math.max(1, loaded.config.limits.maxPagesPerSource * 3),
    ),
    maxInventoryPages: loaded.config.limits.maxPagesPerSource,
    maxInventoryItems: loaded.config.limits.maxRecordsPerSource,
    maxOfferPages: loaded.config.limits.maxPagesPerSource,
    maxOffers: loaded.config.limits.maxRecordsPerSource,
    maxOrderPages: loaded.config.limits.maxPagesPerSource,
    maxOrders: loaded.config.limits.maxRecordsPerSource,
  });
}

function projectShopify(evidence: ShopifyAuthoritativeEvidence): ShopifyCaptureEvidence {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'shopify-authoritative-read-capture',
    identity: evidence.identity,
    variants: evidence.variants,
    orders: evidence.orders,
    provenance: evidence.provenance,
  });
}

function projectInventory(evidence: EbayInventoryEvidence): SafeEbayInventoryEvidence {
  return Object.freeze({
    complete: evidence.complete,
    evidenceMode: evidence.evidenceMode,
    transportProvenance: evidence.transportProvenance,
    environment: evidence.environment,
    capturedAtUtc: evidence.capturedAtUtc,
    identity: evidence.identity,
    coverage: evidence.coverage,
    safeguards: Object.freeze({
      getOnly: true,
      oauthRefreshAbsent: true,
      externalWritesSupported: false,
    }),
    records: evidence.records,
    requests: evidence.requests,
    responseBytes: evidence.responseBytes,
    recordDigest: evidence.recordDigest,
  });
}

function projectOrders(evidence: EbayOrderEvidence): SafeEbayOrderEvidence {
  return Object.freeze({
    complete: evidence.complete,
    evidenceMode: evidence.evidenceMode,
    transportProvenance: evidence.transportProvenance,
    environment: evidence.environment,
    capturedAtUtc: evidence.capturedAtUtc,
    identity: evidence.identity,
    coverage: evidence.coverage,
    safeguards: Object.freeze({
      getOnly: true,
      oauthRefreshAbsent: true,
      externalWritesSupported: false,
      orderFieldsMinimized: true,
    }),
    records: evidence.records,
    inclusiveRecordCount: evidence.rawInclusiveRecordCount,
    requests: evidence.requests,
    responseBytes: evidence.responseBytes,
    recordDigest: evidence.recordDigest,
  });
}

function projectEbay(
  inventory: EbayInventoryEvidence,
  orders: EbayOrderEvidence,
): EbayCaptureEvidence {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'ebay-authoritative-read-capture',
    identity: inventory.identity,
    inventory: projectInventory(inventory),
    orders: projectOrders(orders),
  });
}

function collectionCounts(evidence: SourceCaptureEvidence): EvidenceCollectionResult['counts'] {
  return evidence.kind === 'shopify-authoritative-read-capture'
    ? Object.freeze({
      primary: evidence.variants.length,
      secondary: 0,
      orders: evidence.orders.length,
    })
    : Object.freeze({
      primary: evidence.inventory.records.inventoryItems.length,
      secondary: evidence.inventory.records.offers.length,
      orders: evidence.orders.records.length,
    });
}

export async function runEvidenceCollection(input: {
  repositoryRoot: string;
  environment: Readonly<Record<string, string | undefined>>;
  fetch: EvidenceFetch;
  source: string;
  confirmScopeDigest: string;
  orderStartUtc: string;
  orderEndUtc: string;
  now: () => Date;
  runtimeBuild: EvidenceCaptureRuntimeBuildIdentity;
}): Promise<EvidenceCollectionResult> {
  const source = parseSource(input.source);
  const loaded = loadEvidenceCaptureConfig({
    repositoryRoot: input.repositoryRoot,
    requestedConfigPath: EVIDENCE_CAPTURE_CONFIG_RELATIVE_PATH,
  });
  if (!validRuntimeBuild(input.runtimeBuild, loaded)) deny('build-identity-denied');
  if (!equalDigest(input.confirmScopeDigest, loaded.scopeDigest)) {
    deny('scope-confirmation-denied');
  }
  const now = input.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) deny('window-denied');
  const generatedAtUtc = now.toISOString();
  const orderWindow = validateOrderWindow({
    startUtc: input.orderStartUtc,
    endUtc: input.orderEndUtc,
    nowUtc: generatedAtUtc,
  });
  const signer = createEvidenceArtifactSigner({ loaded, environment: input.environment });

  let evidence: SourceCaptureEvidence;
  if (source === 'shopify') {
    const dispatcher = createShopifyNetworkDispatcher({
      loaded,
      environment: input.environment,
      fetch: input.fetch,
    });
    const collected = await captureShopifyAuthoritativeEvidence({
      storeDomain: loaded.config.identities.shopifyStoreDomain,
      expectedShopId: loaded.config.identities.shopifyShopGid,
      expectedAppId: loaded.config.identities.shopifyAppGid,
      authorityExpiresAtUtc: null,
      orderWindow,
      limits: {
        variantPageSize: Math.min(25, loaded.config.limits.maxRecordsPerSource),
        orderPageSize: Math.min(100, loaded.config.limits.maxRecordsPerSource),
        maxVariantPages: loaded.config.limits.maxPagesPerSource,
        maxOrderPages: loaded.config.limits.maxPagesPerSource,
        maxRequests: 1 + 2 * loaded.config.limits.maxPagesPerSource,
        maxResponseBytes: Math.min(5 * 1024 * 1024, loaded.config.limits.maxResponseBytes),
      },
    }, { dispatcher, now: () => now });
    if (
      collected.variants.length > loaded.config.limits.maxRecordsPerSource
      || collected.orders.length > loaded.config.limits.maxRecordsPerSource
    ) deny('record-limit-exceeded');
    evidence = projectShopify(collected);
  } else {
    const { transport, authorization } = createEbayNetworkTransport({
      loaded,
      environment: input.environment,
      fetch: input.fetch,
      nowUtc: generatedAtUtc,
    });
    const collector = createEbayEvidenceCollector({
      environment: loaded.config.identities.ebayEnvironment,
      capturedAtUtc: generatedAtUtc,
      expectedIdentity: {
        userId: loaded.config.identities.ebayUserId,
        registrationMarketplaceId: loaded.config.identities.ebayRegistrationMarketplaceId,
      },
      authorization,
      limits: ebayCollectorLimits(loaded),
    }, transport);
    const inventory = await collector.collectInventoryAndOffers();
    const orders = await collector.collectRecentOrders(createEbayOrderWindow({
      startUtc: orderWindow.startUtc,
      endUtc: orderWindow.endUtc,
      asOfUtc: generatedAtUtc,
    }));
    evidence = projectEbay(inventory, orders);
  }

  const payload = buildEvidencePayload({
    loaded,
    source,
    evidence,
    generatedAtUtc,
    externalReadsPerformed: true,
  });
  const artifact = signer.sign(payload);
  assertSourceArtifactSchema(artifact, loaded);
  const written = writeEvidenceArtifact({ loaded, artifact });
  return Object.freeze({
    schemaVersion: 1,
    command: 'collect',
    status: 'captured',
    source,
    lane: loaded.config.lane,
    generatedAtUtc,
    orderWindow,
    scopeDigest: loaded.scopeDigest,
    configDigest: loaded.configDigest,
    artifact: Object.freeze({
      relativePath: written.relativePath,
      digest: written.artifactDigest,
    }),
    counts: collectionCounts(evidence),
    networkReadsPerformed: true,
    externalWrites: 0,
    historicalBackfill: false,
    productionParity: false,
    cutoverReady: false,
    historicalVerificationContextArchived: false,
  });
}

function assertCommonArtifactShape(value: unknown): asserts value is EvidenceArtifact<unknown> {
  if (!exactKeys(value, ['payload', 'signature'])) deny('artifact-schema-denied');
  if (!exactKeys(value.payload, [
    'schemaVersion', 'kind', 'source', 'captureId', 'generatedAtUtc', 'scopeDigest',
    'configDigest', 'collector', 'safety', 'evidence',
  ])) deny('artifact-schema-denied');
  if (!exactKeys(value.signature, ['algorithm', 'keyId', 'payloadDigest', 'valueBase64'])) {
    deny('artifact-schema-denied');
  }
  if (!exactKeys(value.payload.collector, ['name', 'version', 'buildCommit'])) {
    deny('artifact-schema-denied');
  }
  if (!exactKeys(value.payload.safety, [
    'externalReadsPerformed', 'externalWrites', 'historicalBackfill', 'oauthAcquisition',
    'accessRefresh', 'rawPayloadPersistence', 'personalDataPersistence', 'ownershipTransferred',
    'cutoverReady', 'productionParity',
  ])) deny('artifact-schema-denied');
  if (
    value.payload.source !== 'shopify' && value.payload.source !== 'ebay'
  ) deny('artifact-schema-denied');
}

function validShopifyIdentity(value: unknown, loaded: LoadedEvidenceCaptureConfig): boolean {
  return exactKeys(value, ['shopId', 'storeDomain', 'appId'])
    && value.shopId === loaded.config.identities.shopifyShopGid
    && value.storeDomain === loaded.config.identities.shopifyStoreDomain
    && value.appId === loaded.config.identities.shopifyAppGid;
}

function validInventoryLocation(value: unknown): boolean {
  return exactKeys(value, ['inventoryLevelId', 'locationId', 'active', 'available', 'updatedAtUtc'])
    && safeString(value.inventoryLevelId, GID_PATTERNS.inventoryLevel)
    && safeString(value.locationId, GID_PATTERNS.location)
    && typeof value.active === 'boolean'
    && Number.isSafeInteger(value.available)
    && canonicalUtc(value.updatedAtUtc);
}

function validShopifyVariant(value: unknown): boolean {
  return exactKeys(value, [
    'productId', 'productStatus', 'productUpdatedAtUtc', 'variantId', 'sku', 'price',
    'aggregateAvailable', 'variantUpdatedAtUtc', 'inventoryItemId', 'inventoryTracked',
    'inventoryByLocation',
  ])
    && safeString(value.productId, GID_PATTERNS.product)
    && safeString(value.productStatus)
    && canonicalUtc(value.productUpdatedAtUtc)
    && safeString(value.variantId, GID_PATTERNS.variant)
    && (value.sku === null || safeString(value.sku))
    && exactKeys(value.price, ['amount', 'currencyCode'])
    && safeString(value.price.amount, /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/)
    && safeString(value.price.currencyCode, /^[A-Z]{3}$/)
    && (value.aggregateAvailable === null || Number.isSafeInteger(value.aggregateAvailable))
    && canonicalUtc(value.variantUpdatedAtUtc)
    && safeString(value.inventoryItemId, GID_PATTERNS.inventoryItem)
    && typeof value.inventoryTracked === 'boolean'
    && Array.isArray(value.inventoryByLocation)
    && value.inventoryByLocation.every(validInventoryLocation);
}

function validShopifyOrder(value: unknown): boolean {
  return exactKeys(value, [
    'orderId', 'createdAtUtc', 'updatedAtUtc', 'app', 'sourceName', 'sourceIdentifier',
    'financialStatus', 'fulfillmentStatus', 'test',
  ])
    && safeString(value.orderId, GID_PATTERNS.order)
    && canonicalUtc(value.createdAtUtc)
    && canonicalUtc(value.updatedAtUtc)
    && (value.app === null || (
      exactKeys(value.app, ['id', 'name'])
      && safeString(value.app.id, GID_PATTERNS.app)
      && safeString(value.app.name)
    ))
    && nullableSafeString(value.sourceName)
    && nullableSafeString(value.sourceIdentifier)
    && nullableSafeString(value.financialStatus)
    && safeString(value.fulfillmentStatus)
    && typeof value.test === 'boolean';
}

function validShopifyEvidence(value: unknown, loaded: LoadedEvidenceCaptureConfig): boolean {
  if (!exactKeys(value, ['schemaVersion', 'kind', 'identity', 'variants', 'orders', 'provenance'])) {
    return false;
  }
  if (
    value.schemaVersion !== 1
    || value.kind !== 'shopify-authoritative-read-capture'
    || !validShopifyIdentity(value.identity, loaded)
    || !Array.isArray(value.variants)
    || !value.variants.every(validShopifyVariant)
    || !Array.isArray(value.orders)
    || !value.orders.every(validShopifyOrder)
    || value.variants.length > loaded.config.limits.maxRecordsPerSource
    || value.orders.length > loaded.config.limits.maxRecordsPerSource
  ) return false;
  const provenance = value.provenance;
  if (!exactKeys(provenance, [
    'source', 'apiVersion', 'endpointHost', 'shopId', 'appId', 'grantedScopes',
    'observedAtUtc', 'orderWindow', 'variantPageCount', 'orderPageCount', 'requestCount',
    'paginationComplete', 'readOnly', 'externalWritesPerformed', 'historicalBackfillPerformed',
  ])) return false;
  const provenanceWindow = provenance.orderWindow as Record<string, unknown>;
  const baseValid = provenance.source === 'shopify-admin-graphql'
    && provenance.apiVersion === SHOPIFY_ADMIN_API_VERSION
    && provenance.endpointHost === loaded.config.identities.shopifyStoreDomain
    && provenance.shopId === loaded.config.identities.shopifyShopGid
    && provenance.appId === loaded.config.identities.shopifyAppGid
    && Array.isArray(provenance.grantedScopes)
    && provenance.grantedScopes.every((scope) => safeString(scope, /^[a-z][a-z0-9_]{1,127}$/))
    && !(provenance.grantedScopes as string[])
      .some((scope) => scope === 'read_all_orders' || scope.startsWith('write_'))
    && ['read_inventory', 'read_orders', 'read_products']
      .every((scope) => (provenance.grantedScopes as string[]).includes(scope))
    && uniqueStrings(provenance.grantedScopes as string[])
    && canonicalUtc(provenance.observedAtUtc)
    && exactKeys(provenance.orderWindow, ['startUtc', 'endUtc'])
    && canonicalUtc(provenanceWindow.startUtc)
    && canonicalUtc(provenanceWindow.endUtc)
    && nonNegativeInteger(provenance.variantPageCount)
    && nonNegativeInteger(provenance.orderPageCount)
    && nonNegativeInteger(provenance.requestCount)
    && provenance.paginationComplete === true
    && provenance.readOnly === true
    && provenance.externalWritesPerformed === false
    && provenance.historicalBackfillPerformed === false;
  if (!baseValid) return false;
  const start = Date.parse(provenanceWindow.startUtc as string);
  const end = Date.parse(provenanceWindow.endUtc as string);
  const observed = Date.parse(provenance.observedAtUtc as string);
  if (
    start >= end
    || end > observed
    || end - start > MAX_ORDER_WINDOW_MS
    || observed - end > MAX_ORDER_WINDOW_LAG_MS
  ) return false;
  const variants = value.variants as Array<Record<string, unknown>>;
  const orders = value.orders as Array<Record<string, unknown>>;
  return uniqueStrings(variants.map((entry) => String(entry.variantId)))
    && uniqueStrings(orders.map((entry) => String(entry.orderId)))
    && orders.every((entry) => {
      const created = Date.parse(String(entry.createdAtUtc));
      return created >= start && created < end;
    });
}

function validEbayIdentity(value: unknown, loaded: LoadedEvidenceCaptureConfig): boolean {
  return exactKeys(value, ['userId', 'registrationMarketplaceId'])
    && value.userId === loaded.config.identities.ebayUserId
    && value.registrationMarketplaceId === loaded.config.identities.ebayRegistrationMarketplaceId;
}

function validEbayProvenance(value: unknown): boolean {
  return exactKeys(value, ['kind', 'captureSessionId'])
    && value.kind === 'direct-ebay-api'
    && safeString(value.captureSessionId, SAFE_ID);
}

function validEbayRequest(value: unknown, loaded: LoadedEvidenceCaptureConfig): value is EbayRequestEvidence {
  const environment = loaded.config.identities.ebayEnvironment;
  const identityHost = environment === 'production' ? 'apiz.ebay.com' : 'apiz.sandbox.ebay.com';
  const sellHost = environment === 'production' ? 'api.ebay.com' : 'api.sandbox.ebay.com';
  if (!exactKeys(value, ['method', 'host', 'path', 'requiredScope']) || value.method !== 'GET') {
    return false;
  }
  if (value.host === identityHost && value.path === '/commerce/identity/v1/user/') {
    return value.requiredScope === EBAY_READ_SCOPES.identity;
  }
  if (value.host !== sellHost) return false;
  if (value.path === '/sell/inventory/v1/inventory_item' || value.path === '/sell/inventory/v1/offer') {
    return value.requiredScope === EBAY_READ_SCOPES.inventory;
  }
  return value.path === '/sell/fulfillment/v1/order'
    && value.requiredScope === EBAY_READ_SCOPES.fulfillment;
}

function validEbayInventoryItem(value: unknown): boolean {
  return exactKeys(value, [
    'sku', 'locale', 'condition', 'inventoryItemGroupKeys', 'shipToLocationQuantity',
  ])
    && safeString(value.sku)
    && nullableSafeString(value.locale)
    && nullableSafeString(value.condition)
    && Array.isArray(value.inventoryItemGroupKeys)
    && value.inventoryItemGroupKeys.every((entry) => safeString(entry))
    && (value.shipToLocationQuantity === null || nonNegativeInteger(value.shipToLocationQuantity));
}

function validEbayOffer(value: unknown, loaded: LoadedEvidenceCaptureConfig): boolean {
  return exactKeys(value, [
    'offerId', 'sku', 'marketplaceId', 'format', 'status', 'availableQuantity',
    'categoryId', 'price', 'listing',
  ])
    && safeString(value.offerId)
    && safeString(value.sku)
    && value.marketplaceId === loaded.config.identities.ebayMarketplaceId
    && nullableSafeString(value.format)
    && nullableSafeString(value.status)
    && (value.availableQuantity === null || nonNegativeInteger(value.availableQuantity))
    && nullableSafeString(value.categoryId)
    && (value.price === null || (
      exactKeys(value.price, ['currency', 'value'])
      && safeString(value.price.currency)
      && safeString(value.price.value)
    ))
    && (value.listing === null || (
      exactKeys(value.listing, ['listingId', 'listingStatus', 'soldQuantity', 'listingOnHold'])
      && nullableSafeString(value.listing.listingId)
      && nullableSafeString(value.listing.listingStatus)
      && (value.listing.soldQuantity === null || nonNegativeInteger(value.listing.soldQuantity))
      && (value.listing.listingOnHold === null || typeof value.listing.listingOnHold === 'boolean')
    ));
}

function validEbayOrder(value: unknown): boolean {
  return exactKeys(value, ['orderId', 'creationDate', 'lastModifiedDate', 'orderFulfillmentStatus'])
    && safeString(value.orderId)
    && canonicalUtc(value.creationDate)
    && canonicalUtc(value.lastModifiedDate)
    && safeString(value.orderFulfillmentStatus);
}

function jsonDigest(value: unknown): string {
  return sha256Digest(value);
}

function validEbayCommon(
  value: unknown,
  loaded: LoadedEvidenceCaptureConfig,
  recordKeys: readonly string[],
  safeguardKeys: readonly string[],
): value is Record<string, unknown> {
  return exactKeys(value, [
    'complete', 'evidenceMode', 'transportProvenance', 'environment', 'capturedAtUtc',
    'identity', 'coverage', 'safeguards', 'records', ...recordKeys,
    'requests', 'responseBytes', 'recordDigest',
  ])
    && value.complete === true
    && value.evidenceMode === 'direct-ebay-api'
    && validEbayProvenance(value.transportProvenance)
    && value.environment === loaded.config.identities.ebayEnvironment
    && canonicalUtc(value.capturedAtUtc)
    && validEbayIdentity(value.identity, loaded)
    && exactKeys(value.safeguards, safeguardKeys)
    && value.safeguards.getOnly === true
    && value.safeguards.oauthRefreshAbsent === true
    && value.safeguards.externalWritesSupported === false
    && Array.isArray(value.requests)
    && value.requests.every((request) => validEbayRequest(request, loaded))
    && nonNegativeInteger(value.responseBytes)
    && exactDigest(value.recordDigest);
}

function validEbayInventory(value: unknown, loaded: LoadedEvidenceCaptureConfig): boolean {
  if (!validEbayCommon(value, loaded, [], [
    'getOnly', 'oauthRefreshAbsent', 'externalWritesSupported',
  ])) return false;
  const baseValid = exactKeys(value.coverage, [
    'model', 'allSellerListingsClaimed', 'tradingApiListingsIncluded', 'activeInventoryReportUsed',
  ])
    && value.coverage.model === 'ebay-inventory-api-records-and-associated-offers-only'
    && value.coverage.allSellerListingsClaimed === false
    && value.coverage.tradingApiListingsIncluded === false
    && value.coverage.activeInventoryReportUsed === false
    && exactKeys(value.records, ['inventoryItems', 'offers'])
    && Array.isArray(value.records.inventoryItems)
    && value.records.inventoryItems.every(validEbayInventoryItem)
    && Array.isArray(value.records.offers)
    && value.records.offers.every((offer) => validEbayOffer(offer, loaded))
    && value.records.inventoryItems.length <= loaded.config.limits.maxRecordsPerSource
    && value.records.offers.length <= loaded.config.limits.maxRecordsPerSource
    && value.recordDigest === jsonDigest(value.records);
  if (!baseValid) return false;
  const inventoryRecords = value.records as Record<string, unknown>;
  const inventoryItems = inventoryRecords.inventoryItems as Array<Record<string, unknown>>;
  const offers = inventoryRecords.offers as Array<Record<string, unknown>>;
  const skus = inventoryItems.map((entry) => String(entry.sku));
  return uniqueStrings(skus)
    && uniqueStrings(offers.map((entry) => String(entry.offerId)))
    && offers.every((entry) => skus.includes(String(entry.sku)))
    && (value.requests as unknown[]).length <= 1 + 2 * loaded.config.limits.maxPagesPerSource;
}

function validEbayOrders(value: unknown, loaded: LoadedEvidenceCaptureConfig): boolean {
  if (!validEbayCommon(value, loaded, ['inclusiveRecordCount'], [
    'getOnly', 'oauthRefreshAbsent', 'externalWritesSupported', 'orderFieldsMinimized',
  ])) return false;
  if (!isRecord(value.coverage) || !isRecord(value.coverage.window)) return false;
  const safeguards = value.safeguards as Record<string, unknown>;
  const coverage = value.coverage as Record<string, unknown>;
  const coverageWindow = coverage.window as Record<string, unknown>;
  const baseValid = safeguards.orderFieldsMinimized === true
    && exactKeys(value.coverage, ['model', 'window', 'historicalBackfill', 'cutoverWatermark'])
    && value.coverage.model === 'ebay-fulfillment-completed-checkout-orders'
    && value.coverage.historicalBackfill === false
    && value.coverage.cutoverWatermark === false
    && exactKeys(value.coverage.window, [
      'startUtc', 'endUtc', 'lowerBoundInclusive', 'upperBoundExclusive',
      'ebayQueryUpperBoundIsInclusive', 'upperBoundaryPostFiltered',
    ])
    && canonicalUtc(value.coverage.window.startUtc)
    && canonicalUtc(value.coverage.window.endUtc)
    && value.coverage.window.lowerBoundInclusive === true
    && value.coverage.window.upperBoundExclusive === true
    && value.coverage.window.ebayQueryUpperBoundIsInclusive === true
    && value.coverage.window.upperBoundaryPostFiltered === true
    && Array.isArray(value.records)
    && value.records.every(validEbayOrder)
    && value.records.length <= loaded.config.limits.maxRecordsPerSource
    && nonNegativeInteger(value.inclusiveRecordCount)
    && value.inclusiveRecordCount >= value.records.length
    && value.recordDigest === jsonDigest(value.records);
  if (!baseValid) return false;
  const start = Date.parse(coverageWindow.startUtc as string);
  const end = Date.parse(coverageWindow.endUtc as string);
  const capturedAt = Date.parse(value.capturedAtUtc as string);
  const orders = value.records as Array<Record<string, unknown>>;
  return start < end
    && end <= capturedAt
    && end - start <= MAX_ORDER_WINDOW_MS
    && capturedAt - end <= MAX_ORDER_WINDOW_LAG_MS
    && uniqueStrings(orders.map((entry) => String(entry.orderId)))
    && orders.every((entry) => {
      const created = Date.parse(String(entry.creationDate));
      return created >= start && created < end;
    })
    && (value.requests as unknown[]).length <= 1 + loaded.config.limits.maxPagesPerSource;
}

function validEbayEvidence(value: unknown, loaded: LoadedEvidenceCaptureConfig): boolean {
  if (!exactKeys(value, ['schemaVersion', 'kind', 'identity', 'inventory', 'orders'])) return false;
  if (
    value.schemaVersion !== 1
    || value.kind !== 'ebay-authoritative-read-capture'
    || !validEbayIdentity(value.identity, loaded)
    || !validEbayInventory(value.inventory, loaded)
    || !validEbayOrders(value.orders, loaded)
  ) return false;
  const inventory = value.inventory as Record<string, unknown>;
  const orders = value.orders as Record<string, unknown>;
  const inventoryProvenance = inventory.transportProvenance as Record<string, unknown>;
  const orderProvenance = orders.transportProvenance as Record<string, unknown>;
  return inventory.capturedAtUtc === orders.capturedAtUtc
    && inventoryProvenance.captureSessionId === orderProvenance.captureSessionId;
}

export function assertSourceArtifactSchema(
  artifactInput: unknown,
  loaded: LoadedEvidenceCaptureConfig,
): asserts artifactInput is EvidenceArtifact<SourceCaptureEvidence> {
  assertCommonArtifactShape(artifactInput);
  verifyEvidenceArtifact({ artifact: artifactInput, loaded });
  if (
    artifactInput.payload.schemaVersion !== 1
    || artifactInput.payload.kind !== 'product-pipeline-authoritative-read-evidence'
    || artifactInput.payload.collector.name !== loaded.config.collector.name
    || artifactInput.payload.collector.version !== loaded.config.collector.version
    || artifactInput.payload.collector.buildCommit !== loaded.config.collector.buildCommit
    || artifactInput.payload.safety.externalReadsPerformed !== true
  ) deny('artifact-schema-denied');
  const valid = artifactInput.payload.source === 'shopify'
    ? validShopifyEvidence(artifactInput.payload.evidence, loaded)
    : validEbayEvidence(artifactInput.payload.evidence, loaded);
  if (!valid) deny('artifact-schema-denied');
  const observedAtUtc = artifactInput.payload.source === 'shopify'
    ? (artifactInput.payload.evidence as ShopifyCaptureEvidence).provenance.observedAtUtc
    : (artifactInput.payload.evidence as EbayCaptureEvidence).inventory.capturedAtUtc;
  if (artifactInput.payload.generatedAtUtc !== observedAtUtc) deny('artifact-schema-denied');
}

export function verifyLocalEvidenceArtifact(input: {
  repositoryRoot: string;
  requestedArtifactPath: string;
  now: () => Date;
  runtimeBuild: EvidenceCaptureRuntimeBuildIdentity;
}): EvidenceVerificationResult {
  const loaded = loadEvidenceCaptureConfig({
    repositoryRoot: input.repositoryRoot,
    requestedConfigPath: EVIDENCE_CAPTURE_CONFIG_RELATIVE_PATH,
  });
  const artifact = readEvidenceArtifact({
    loaded,
    requestedArtifactPath: input.requestedArtifactPath,
  });
  assertSourceArtifactSchema(artifact, loaded);
  const now = input.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) deny('artifact-schema-denied');
  const age = now.getTime() - Date.parse(artifact.payload.generatedAtUtc);
  const freshness = age < 0 ? 'future' : age <= MAX_ORDER_WINDOW_LAG_MS ? 'fresh' : 'stale';
  const evidence = artifact.payload.evidence;
  const source = artifact.payload.source;
  if (source !== 'shopify' && source !== 'ebay') deny('artifact-schema-denied');
  return Object.freeze({
    schemaVersion: 1,
    command: 'verify',
    status: 'verified',
    source,
    generatedAtUtc: artifact.payload.generatedAtUtc,
    artifactRelativePath: input.requestedArtifactPath,
    artifactDigest: sha256Digest(artifact),
    scopeDigest: artifact.payload.scopeDigest,
    configDigest: artifact.payload.configDigest,
    counts: collectionCounts(evidence),
    signatureValid: true,
    sourceSchemaValid: true,
    freshness,
    currentReadEvidence: freshness === 'fresh'
      && input.runtimeBuild.headCommit === artifact.payload.collector.buildCommit
      && input.runtimeBuild.collectorTreeClean === true,
    parityUseAllowed: false,
    signedCollectorBuildCommit: artifact.payload.collector.buildCommit,
    currentCheckoutMatchesSignedBuild:
      input.runtimeBuild.headCommit === artifact.payload.collector.buildCommit,
    currentCollectorTreeClean: input.runtimeBuild.collectorTreeClean,
    historicalVerificationContextArchived: false,
    externalWrites: 0,
    historicalBackfill: false,
    productionParity: false,
    cutoverReady: false,
  });
}
