import { createHash } from 'node:crypto';
import {
  PRODUCTION_CAN3570_LISTING_EVIDENCE,
  PRODUCTION_CAN3570_LISTING_EVIDENCE_EXPECTED_DIGEST,
  type ProductionCan3570ListingEvidence,
} from './evidence/production-can3570-authoritative-listing.v1.js';

export type AuthoritativeListingStatus = 'attention' | 'ready' | 'active' | 'ended';

export type AuthoritativeListingProjection = Readonly<{
  id: string;
  shopify: Readonly<{
    productId: string;
    variantId: string;
    sku: string;
    title: string;
    primaryImageUrl: string | null;
    imageCount: number;
  }>;
  ebay: Readonly<{
    listingId: string;
    offerId: string;
    url: string;
  }>;
  price: Readonly<{ amount: string; currency: 'USD' }> | null;
  lifecycleStatus: AuthoritativeListingStatus;
  lastVerifiedAtUtc: string;
  audit: Readonly<{
    verified: boolean;
    evidenceState: 'verified' | 'invalid' | 'unavailable';
    unresolvedCount: number;
    recoverySupported: boolean;
    currentRemoteStateVerified: boolean;
  }>;
}>;

export type AuthoritativeListingsPage = Readonly<{
  schemaVersion: 1;
  data: readonly AuthoritativeListingProjection[];
  total: number;
  limit: number;
  offset: number;
  source: 'production-listing-audit-ledger';
  evidenceKind: 'verified_snapshot';
  authoritative: false;
  remoteReadPerformed: false;
  externalWritesPerformed: 0;
}>;

export class AuthoritativeListingEvidenceError extends Error {
  constructor() {
    super('Verified listing evidence is unavailable');
    this.name = 'AuthoritativeListingEvidenceError';
  }
}

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const PUBLIC_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CREDENTIAL_KEY_PATTERN = /(?:authorization|access.?token|refresh.?token|id.?token|client.?secret|password|cookie|credential|api.?key)$/i;
const CREDENTIAL_VALUE_PATTERN = /\bbearer\s+[a-z0-9._~+/=-]{4,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;

const EXPECTED_SOURCE = Object.freeze({
  sourceFileDigest:
    'sha256:b3433394dfdadd254067297cc81fc32ebdb3fd13f105726e9da1a890ef64e7ce',
  sourceAuditRecordCount: 16,
  sourceAuditHead:
    'sha256:d595f96cf098055041ebcc163713966e44c28fc0fef520ae435e48aa73ad68db',
  schemaCatalogDigest:
    'sha256:e2351a8f40668012b342f5c63867b0c13cf7a9062fdca51e9956c06280d1e6e5',
  manifestDigest:
    'sha256:91b491b3361cb63a753e25659a7329d85fdf6d66d666455a859a3b6aa002fcb2',
  approvedPayloadDigest:
    'sha256:9a5e230f5537a145e816b9754da19b37c2fe8af64eb588ab7d180549c02d844c',
  effectGraphDigest:
    'sha256:585e62e24b12cb9aa6f1a0c7c8fe82ef6d802a52698f8c53bec515b40cc457ca',
  publishedEffectProofDigest:
    'sha256:2a8ce25791ef9229b0749909f56b0ecf0fff5819b2cafba3abfd9f5c587e8777',
  redactedSuccessEvidenceDigest:
    'sha256:d0d3809fbc138f76945464af6add76b3d5578bef333bbc60a7179aa5e63ae750',
  verifiedAtUtc: '2026-08-13T16:43:19.281Z',
});

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function digestAuthoritativeListingEvidence(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasForbiddenMaterial(value: unknown, key = ''): boolean {
  if (CREDENTIAL_KEY_PATTERN.test(key)) return true;
  if (typeof value === 'string') return CREDENTIAL_VALUE_PATTERN.test(value);
  if (Array.isArray(value)) return value.some((entry) => hasForbiddenMaterial(entry));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([nestedKey, nested]) => hasForbiddenMaterial(nested, nestedKey));
}

function exactObject(value: unknown, expected: unknown): boolean {
  return canonicalJson(value) === canonicalJson(expected);
}

/**
 * Strictly validates the checked-in evidence asset. This accepts no general
 * listing shape: every source proof and public identifier is pinned to the
 * verified Canon canary. A changed or expanded artifact fails closed.
 */
export function verifyAuthoritativeListingEvidence(
  evidence: unknown,
): asserts evidence is ProductionCan3570ListingEvidence {
  if (!isRecord(evidence)
    || !exactKeys(evidence, [
      'schemaVersion', 'kind', 'evidenceKind', 'source', 'listing', 'redaction', 'digest',
    ])
    || evidence.schemaVersion !== 1
    || evidence.kind !== 'product-pipeline-authoritative-listing-verified-snapshot'
    || evidence.evidenceKind !== 'verified_snapshot'
    || evidence.digest !== PRODUCTION_CAN3570_LISTING_EVIDENCE_EXPECTED_DIGEST
    || !DIGEST_PATTERN.test(String(evidence.digest))
    || hasForbiddenMaterial(evidence)) {
    throw new AuthoritativeListingEvidenceError();
  }

  const { digest: _digest, ...body } = evidence;
  if (digestAuthoritativeListingEvidence(body)
    !== PRODUCTION_CAN3570_LISTING_EVIDENCE_EXPECTED_DIGEST) {
    throw new AuthoritativeListingEvidenceError();
  }

  const { source, listing, redaction } = evidence;
  if (!isRecord(source)
    || !exactKeys(source, [
      'kind', 'strictVerifier', 'environment', 'sourceFileDigest',
      'sourceAuditRecordCount', 'sourceAuditHead', 'schemaCatalogDigest',
      'manifestDigest', 'approvedPayloadDigest', 'effectGraphDigest',
      'publishedEffectProofDigest', 'redactedSuccessEvidenceDigest',
      'verifiedAtUtc', 'remoteReadPerformedAtRequestTime',
    ])
    || source.kind !== 'production-listing-audit-ledger'
    || source.strictVerifier !== 'production-listing-store-v1'
    || source.environment !== 'production'
    || source.remoteReadPerformedAtRequestTime !== false
    || !exactObject({
      sourceFileDigest: source.sourceFileDigest,
      sourceAuditRecordCount: source.sourceAuditRecordCount,
      sourceAuditHead: source.sourceAuditHead,
      schemaCatalogDigest: source.schemaCatalogDigest,
      manifestDigest: source.manifestDigest,
      approvedPayloadDigest: source.approvedPayloadDigest,
      effectGraphDigest: source.effectGraphDigest,
      publishedEffectProofDigest: source.publishedEffectProofDigest,
      redactedSuccessEvidenceDigest: source.redactedSuccessEvidenceDigest,
      verifiedAtUtc: source.verifiedAtUtc,
    }, EXPECTED_SOURCE)
    || Object.entries(source).some(([key, value]) => key.toLowerCase().includes('digest')
      && !DIGEST_PATTERN.test(String(value)))) {
    throw new AuthoritativeListingEvidenceError();
  }

  if (!isRecord(listing)
    || !exactKeys(listing, ['id', 'lifecycleStatus', 'shopify', 'ebay', 'price', 'audit'])
    || listing.id !== 'production:EBAY_US:CAN3570-U119'
    || listing.lifecycleStatus !== 'active'
    || !isRecord(listing.shopify)
    || !exactKeys(listing.shopify, ['productId', 'variantId', 'sku', 'title', 'imageUrls'])
    || listing.shopify.productId !== 'gid://shopify/Product/10310708035875'
    || listing.shopify.variantId !== 'gid://shopify/ProductVariant/55396000563491'
    || listing.shopify.sku !== 'CAN3570-U119'
    || listing.shopify.title !== 'Canon 35-70mm f/3.5-4.5 (#119) *USED*'
    || !Array.isArray(listing.shopify.imageUrls)
    || listing.shopify.imageUrls.length !== 6
    || listing.shopify.imageUrls.some((url) => {
      try {
        const parsed = new URL(String(url));
        return parsed.protocol !== 'https:' || parsed.hostname !== 'cdn.shopify.com'
          || parsed.search !== '' || parsed.hash !== '';
      } catch {
        return true;
      }
    })
    || !isRecord(listing.ebay)
    || !exactKeys(listing.ebay, ['marketplaceId', 'offerId', 'listingId', 'url'])
    || listing.ebay.marketplaceId !== 'EBAY_US'
    || listing.ebay.offerId !== '234942877011'
    || listing.ebay.listingId !== '147502608418'
    || listing.ebay.url !== 'https://www.ebay.com/itm/147502608418'
    || !PUBLIC_ID_PATTERN.test(String(listing.ebay.offerId))
    || !PUBLIC_ID_PATTERN.test(String(listing.ebay.listingId))
    || !isRecord(listing.price)
    || !exactKeys(listing.price, ['amount', 'currency'])
    || listing.price.amount !== '39.95'
    || listing.price.currency !== 'USD'
    || !isRecord(listing.audit)
    || !exactKeys(listing.audit, [
      'verified', 'evidenceState', 'unresolvedCount', 'recoverySupported',
      'currentRemoteStateVerified', 'retryPerformed', 'rollbackDispatched', 'oneAction',
    ])
    || listing.audit.verified !== true
    || listing.audit.evidenceState !== 'verified'
    || listing.audit.unresolvedCount !== 0
    || listing.audit.recoverySupported !== true
    || listing.audit.currentRemoteStateVerified !== false
    || listing.audit.retryPerformed !== false
    || listing.audit.rollbackDispatched !== false
    || listing.audit.oneAction !== true
    || !isRecord(redaction)
    || !exactKeys(redaction, [
      'credentialMaterialPresent', 'sellerIdentifiersPresent',
      'productDescriptionPresent', 'customerDataPresent',
    ])
    || Object.values(redaction).some((value) => value !== false)) {
    throw new AuthoritativeListingEvidenceError();
  }
}

export function readAuthoritativeListingsPage(input: Readonly<{
  limit: number;
  offset: number;
  search?: string;
  status?: AuthoritativeListingStatus;
  evidence?: unknown;
}>): AuthoritativeListingsPage {
  const evidence = input.evidence ?? PRODUCTION_CAN3570_LISTING_EVIDENCE;
  verifyAuthoritativeListingEvidence(evidence);

  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100
    || !Number.isInteger(input.offset) || input.offset < 0) {
    throw new AuthoritativeListingEvidenceError();
  }

  const listing = evidence.listing;
  const projection: AuthoritativeListingProjection = Object.freeze({
    id: listing.id,
    shopify: Object.freeze({
      productId: listing.shopify.productId,
      variantId: listing.shopify.variantId,
      sku: listing.shopify.sku,
      title: listing.shopify.title,
      primaryImageUrl: listing.shopify.imageUrls[0] ?? null,
      imageCount: listing.shopify.imageUrls.length,
    }),
    ebay: Object.freeze({
      listingId: listing.ebay.listingId,
      offerId: listing.ebay.offerId,
      url: listing.ebay.url,
    }),
    price: Object.freeze({ ...listing.price }),
    lifecycleStatus: listing.lifecycleStatus,
    lastVerifiedAtUtc: evidence.source.verifiedAtUtc,
    audit: Object.freeze({
      verified: listing.audit.verified,
      evidenceState: listing.audit.evidenceState,
      unresolvedCount: listing.audit.unresolvedCount,
      recoverySupported: listing.audit.recoverySupported,
      currentRemoteStateVerified: listing.audit.currentRemoteStateVerified,
    }),
  });

  const search = input.search?.trim().toLocaleLowerCase() ?? '';
  const matchesSearch = !search || [
    projection.id,
    projection.shopify.productId,
    projection.shopify.variantId,
    projection.shopify.sku,
    projection.shopify.title,
    projection.ebay.offerId,
    projection.ebay.listingId,
  ].some((value) => value.toLocaleLowerCase().includes(search));
  const matchesStatus = input.status === undefined || input.status === projection.lifecycleStatus;
  const matched = matchesSearch && matchesStatus ? [projection] : [];
  const data = matched.slice(input.offset, input.offset + input.limit);

  return Object.freeze({
    schemaVersion: 1 as const,
    data: Object.freeze(data),
    total: matched.length,
    limit: input.limit,
    offset: input.offset,
    source: 'production-listing-audit-ledger' as const,
    evidenceKind: 'verified_snapshot' as const,
    authoritative: false as const,
    remoteReadPerformed: false as const,
    externalWritesPerformed: 0 as const,
  });
}
