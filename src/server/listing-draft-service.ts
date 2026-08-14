import { randomUUID } from 'node:crypto';
import {
  ListingControlStoreError,
  deriveListingBaseDigests,
  openListingControlStore,
  openListingControlStoreReadOnly,
  sha256Digest,
  type Digest,
  type ListingFieldInput,
  type ListingFieldName,
  type ListingIdentity,
  type ListingRevision,
} from '../listing-control-store/index.js';
import {
  LISTING_DRAFT_SCOPE,
  LISTING_DRAFT_SINGLE_WRITER_ACK,
} from '../listing-control-config.js';
import {
  ListingWorkspaceReaderError,
  readListingWorkspace,
  type ListingWorkspaceDto,
} from './listing-workspace-reader.js';

export { LISTING_DRAFT_SCOPE } from '../listing-control-config.js';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const CATALOG_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/;
const PROHIBITED = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b/i,
  /\bshpat_[A-Za-z0-9_-]{16,}\b/i,
  /(?:v\^|v%5e)1\.1(?:#|%23)[^\s"']{8,}(?:t\^|t%5e)/i,
  /\b(?:access|refresh|identity)[_-]?token\s*[:=]/i,
  /\b(?:api[_-]?key|client[_-]?secret|authorization|set-cookie)\s*[:=]/i,
] as const;
const IMAGE_HOSTS = new Set([
  'cdn.shopify.com',
  'i.ebayimg.com',
  'thumbs.ebaystatic.com',
  'secureir.ebaystatic.com',
  'i.ebaystatic.com',
]);
const SHOPIFY_IMAGE_QUERY_KEYS = new Set(['v', 'width', 'height', 'crop', 'format']);

export type ListingDraftField = Readonly<{
  shopify: string | null;
  ebay: string | null;
  draft: string | null;
  editable: boolean;
}>;

export type ListingDraftDto = Readonly<{
  schemaVersion: 1;
  mode: 'local_draft_only';
  catalogId: string;
  identity: ListingIdentity;
  base: Readonly<{
    catalogObservedAtUtc: string;
    detailObservedAtUtc: string | null;
    sourceDigest: Digest;
    ebayDigest: Digest;
  }>;
  revision: null | Readonly<{
    revisionId: string;
    revisionNumber: number;
    revisionDigest: Digest;
    state: 'draft';
    createdAtUtc: string;
  }>;
  sections: Readonly<{
    listing: Readonly<{
      title: ListingDraftField;
      category: ListingDraftField;
      condition: ListingDraftField;
      conditionDescription: ListingDraftField;
      price: ListingDraftField;
      quantity: ListingDraftField;
    }>;
    content: Readonly<{
      description: ListingDraftField;
      images: ListingDraftField;
      itemSpecifics: ListingDraftField;
      identifiers: ListingDraftField;
    }>;
    delivery: Readonly<{
      fulfillmentPolicyId: ListingDraftField;
      paymentPolicyId: ListingDraftField;
      returnPolicyId: ListingDraftField;
      merchantLocation: ListingDraftField;
    }>;
  }>;
  capabilities: Readonly<{
    saveDraft: boolean;
    previewChanges: boolean;
    apply: false;
    publish: false;
  }>;
  externalWritesPerformed: 0;
}>;

export type SaveListingDraftRequest = Readonly<{
  schemaVersion: 1;
  action: 'save_local_draft';
  catalogId: string;
  expectedRevisionDigest: Digest | null;
  base: Readonly<{ sourceDigest: Digest; ebayDigest: Digest }>;
  draft: Readonly<{
    title: string | null;
    category: string | null;
    condition: string | null;
    conditionDescription: string | null;
    description: string | null;
    images: string | null;
    fulfillmentPolicyId: string | null;
    paymentPolicyId: string | null;
    returnPolicyId: string | null;
    merchantLocation: string | null;
  }>;
}>;

export type ListingDraftFailureCode =
  | 'LISTING_DRAFT_INVALID'
  | 'LISTING_DRAFT_FORBIDDEN'
  | 'LISTING_DRAFT_NOT_FOUND'
  | 'LISTING_DRAFT_STALE'
  | 'LISTING_DRAFT_UNAVAILABLE';

export class ListingDraftServiceError extends Error {
  constructor(readonly code: ListingDraftFailureCode) {
    super('Listing draft operation failed');
    this.name = 'ListingDraftServiceError';
  }
}

const invalid = (): never => { throw new ListingDraftServiceError('LISTING_DRAFT_INVALID'); };
const unavailable = (): never => { throw new ListingDraftServiceError('LISTING_DRAFT_UNAVAILABLE'); };

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return JSON.stringify(actual) === JSON.stringify([...keys].sort());
}

function boundedNullable(value: unknown, maximum: number): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > maximum
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)
    || PROHIBITED.some((pattern) => pattern.test(value))) return invalid();
  return value;
}

function exactOverrideText(value: unknown, maximum: number): string | null {
  const checked = boundedNullable(value, maximum);
  if (checked !== null && (checked.length === 0 || checked.trim() !== checked)) return invalid();
  return checked;
}

function exactNumericId(value: unknown): string | null {
  const checked = exactOverrideText(value, 32);
  if (checked !== null && !/^[1-9][0-9]{0,31}$/.test(checked)) return invalid();
  return checked;
}

function exactSafeIdentifier(value: unknown): string | null {
  const checked = exactOverrideText(value, 128);
  if (checked !== null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(checked)) return invalid();
  return checked;
}

function canonicalImages(value: unknown): string | null {
  const checked = boundedNullable(value, 48_000);
  if (checked === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(checked); } catch { return invalid(); }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 24) return invalid();
  const urls = parsed.map((entry) => {
    if (typeof entry !== 'string' || entry.length > 2_048) return invalid();
    let url: URL;
    try { url = new URL(entry); } catch { return invalid(); }
    const host = url.hostname.toLowerCase();
    const keys = [...url.searchParams.keys()];
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== ''
      || url.hash !== '' || !IMAGE_HOSTS.has(host)
      || (host === 'cdn.shopify.com'
        ? keys.some((key) => !SHOPIFY_IMAGE_QUERY_KEYS.has(key)
          || url.searchParams.getAll(key).length !== 1
          || !/^[A-Za-z0-9._-]{1,64}$/.test(url.searchParams.get(key) ?? ''))
        : keys.length !== 0)) {
      return invalid();
    }
    return url.toString();
  });
  if (new Set(urls).size !== urls.length) return invalid();
  return JSON.stringify(urls);
}

/** Strict browser contract. Unknown/provider/identity/provenance keys fail closed. */
export function parseSaveListingDraftRequest(value: unknown): SaveListingDraftRequest {
  let serialized = '';
  try { serialized = JSON.stringify(value); } catch { return invalid(); }
  if (serialized.length > 65_536 || PROHIBITED.some((pattern) => pattern.test(serialized))) {
    return invalid();
  }
  if (!exactKeys(value, [
    'schemaVersion', 'action', 'catalogId', 'expectedRevisionDigest', 'base', 'draft',
  ]) || value.schemaVersion !== 1 || value.action !== 'save_local_draft'
    || typeof value.catalogId !== 'string' || !CATALOG_ID.test(value.catalogId)
    || (value.expectedRevisionDigest !== null
      && (typeof value.expectedRevisionDigest !== 'string' || !DIGEST.test(value.expectedRevisionDigest)))
    || !exactKeys(value.base, ['sourceDigest', 'ebayDigest'])
    || typeof value.base.sourceDigest !== 'string' || !DIGEST.test(value.base.sourceDigest)
    || typeof value.base.ebayDigest !== 'string' || !DIGEST.test(value.base.ebayDigest)
    || !exactKeys(value.draft, [
      'title', 'category', 'condition', 'conditionDescription', 'description', 'images',
      'fulfillmentPolicyId', 'paymentPolicyId', 'returnPolicyId', 'merchantLocation',
    ])) return invalid();
  const draft = value.draft;
  return Object.freeze({
    schemaVersion: 1 as const,
    action: 'save_local_draft' as const,
    catalogId: value.catalogId,
    expectedRevisionDigest: value.expectedRevisionDigest as Digest | null,
    base: Object.freeze({
      sourceDigest: value.base.sourceDigest as Digest,
      ebayDigest: value.base.ebayDigest as Digest,
    }),
    draft: Object.freeze({
      title: exactOverrideText(draft.title, 80),
      category: exactNumericId(draft.category),
      condition: exactNumericId(draft.condition),
      conditionDescription: exactOverrideText(draft.conditionDescription, 1_000),
      description: (() => {
        const description = exactOverrideText(draft.description, 20_000);
        if (description !== null && /<\/?[A-Za-z][^>]*>/u.test(description)) return invalid();
        return description;
      })(),
      images: canonicalImages(draft.images),
      fulfillmentPolicyId: exactNumericId(draft.fulfillmentPolicyId),
      paymentPolicyId: exactNumericId(draft.paymentPolicyId),
      returnPolicyId: exactNumericId(draft.returnPolicyId),
      merchantLocation: exactSafeIdentifier(draft.merchantLocation),
    }),
  });
}

function json(value: unknown): string { return JSON.stringify(value); }
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') return invalid();
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
  ).join(',')}}`;
}
function htmlToPlainText(value: string | null): string | null {
  if (value === null) return null;
  const withoutActiveContent = value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ')
    .replace(/<!--([\s\S]*?)-->/gu, ' ')
    .replace(/<[^>]*>/gu, ' ');
  const decoded = withoutActiveContent
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d{1,7});/g, (_match, digits: string) => {
      const point = Number(digits);
      return Number.isSafeInteger(point) && point >= 32 && point <= 0x10ffff
        ? String.fromCodePoint(point) : ' ';
    })
    .replace(/\s+/gu, ' ').trim();
  return decoded.length === 0 ? null : decoded;
}
function money(value: { value?: string; amount?: string; currency: string } | null): string | null {
  if (!value) return null;
  return json({ amount: value.value ?? value.amount, currency: value.currency });
}
function quantity(value: number | null): string | null {
  return Number.isSafeInteger(value) && value! >= 0 ? String(value) : null;
}

type Values = Record<ListingFieldName, string | null>;
type Basis = Readonly<{
  workspace: ListingWorkspaceDto;
  identity: ListingIdentity;
  source: Values;
  observed: Values;
  sourceDigest: Digest;
  ebayDigest: Digest;
  ebayObservedAtUtc: string;
}>;

function eligibleBasis(workspace: ListingWorkspaceDto): Basis {
  const row = workspace.catalog;
  const shopify = row.shopify;
  if (!shopify) return unavailable();
  const active = row.lifecycleStatus === 'active' && workspace.mapping.state === 'mapped';
  const notListed = row.lifecycleStatus === 'not_listed'
    && workspace.mapping.state === 'shopify_only';
  if (workspace.schemaVersion !== 1 || workspace.evidence.freshness !== 'live'
    || workspace.evidence.externalWritesPerformed !== 0
    || !/^gid:\/\/shopify\/Product\/[1-9][0-9]*$/.test(shopify.productId)
    || !/^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]*$/.test(shopify.variantId)
    || !/^[\x20-\x7e]{1,128}$/.test(shopify.sku) || shopify.sku.trim() !== shopify.sku
    || shopify.sku !== row.ebay.sku || shopify.sku.length > 128
    || row.audit.verified !== true || row.audit.evidenceState !== 'live_verified'
    || row.audit.currentRemoteStateVerified !== true || row.audit.unresolvedCount !== 0
    || row.audit.attentionReasons.length !== 0 || (!active && !notListed)
    || (active && !workspace.ebayDetail) || (notListed && workspace.ebayDetail !== null)
    || (notListed && (row.ebay.listingId !== null || row.ebay.offerId !== null
      || row.ebay.activeMatchCount !== 0 || row.ebay.inventoryItemCount !== 0
      || row.ebay.offerCount !== 0 || row.ebay.unpublishedArtifactCount !== 0))) unavailable();

  const detail = workspace.ebayDetail;
  if (detail && (detail.identity.sellerId !== LISTING_DRAFT_SCOPE.ebaySellerId
    || detail.identity.marketplaceId !== LISTING_DRAFT_SCOPE.ebayMarketplaceId
    || detail.identity.shopifyProductId !== shopify.productId
    || detail.identity.shopifyVariantId !== shopify.variantId
    || detail.identity.sku !== shopify.sku
    || detail.identity.listingId !== row.ebay.listingId
    || detail.identity.offerId !== row.ebay.offerId
    || !detail.management.exactBindings.seller || !detail.management.exactBindings.listing
    || !detail.management.exactBindings.sku || !detail.management.lifecycleAligned)) unavailable();

  const managementModel: ListingIdentity['managementModel'] = workspace.mapping.managementModel === 'inventory_offer'
    ? 'inventory_api'
    : workspace.mapping.managementModel === 'legacy_trading' ? 'trading_api' : 'unmanaged';
  if (active && (row.ebay.activeMatchCount !== 1 || row.ebay.unpublishedArtifactCount !== 0)) {
    unavailable();
  }
  if (managementModel === 'inventory_api' && (!detail
    || workspace.mapping.inventorySku !== shopify.sku
    || row.ebay.inventoryItemCount !== 1 || row.ebay.offerCount !== 1
    || detail.management.model !== 'inventory_offer'
    || detail.management.controlApi !== 'inventory'
    || !detail.management.exactBindings.inventoryItem || !detail.management.exactBindings.offer
    || !detail.management.exactBindings.offerToListing
    || detail.management.inventoryItem?.sku !== shopify.sku
    || detail.management.offer?.sku !== shopify.sku
    || detail.management.offer.offerId !== row.ebay.offerId
    || detail.management.offer.marketplaceId !== LISTING_DRAFT_SCOPE.ebayMarketplaceId)) unavailable();
  if (managementModel === 'trading_api' && (!detail
    || row.ebay.inventoryItemCount !== 0 || row.ebay.offerCount !== 0
    || row.ebay.offerId !== null || detail.management.model !== 'legacy_trading'
    || detail.management.controlApi !== 'trading'
    || detail.management.inventoryItem !== null || detail.management.offer !== null
    || detail.management.exactBindings.inventoryItem || detail.management.exactBindings.offer
    || detail.management.exactBindings.offerToListing)) unavailable();
  const identity: ListingIdentity = Object.freeze({
    shopifyProductGid: shopify.productId,
    shopifyVariantGid: shopify.variantId,
    rawSku: shopify.sku,
    ebaySellerId: LISTING_DRAFT_SCOPE.ebaySellerId,
    ebayMarketplaceId: LISTING_DRAFT_SCOPE.ebayMarketplaceId,
    managementModel,
    ebayInventorySku: managementModel === 'inventory_api' ? shopify.sku : null,
    ebayOfferId: row.ebay.offerId,
    ebayListingId: row.ebay.listingId,
  });

  const actual = detail?.actual;
  const source: Values = {
    title: shopify.title,
    category: null,
    condition: null,
    condition_description: null,
    price: money(shopify.price),
    quantity: quantity(shopify.available),
    description: null,
    images: null,
    item_specifics: null,
    identifiers: null,
    fulfillment_policy: null,
    payment_policy: null,
    return_policy: null,
    merchant_location: null,
  };
  const observed: Values = {
    title: actual?.content.title ?? null,
    category: actual?.category.primary.id ?? null,
    condition: actual?.condition.id ?? null,
    condition_description: actual?.condition.description ?? null,
    price: money(actual?.commerce.price ?? null),
    quantity: quantity(actual?.commerce.availableQuantity ?? null),
    description: htmlToPlainText(actual?.content.descriptionHtml ?? null),
    images: actual ? json(actual.content.imageUrls) : null,
    item_specifics: actual ? canonicalJson(actual.aspects) : null,
    identifiers: actual ? canonicalJson(actual.identifiers) : null,
    fulfillment_policy: actual?.policies.fulfillmentPolicyId ?? null,
    payment_policy: actual?.policies.paymentPolicyId ?? null,
    return_policy: actual?.policies.returnPolicyId ?? null,
    merchant_location: detail?.management.offer?.merchantLocationKey ?? null,
  };
  const sourceDigest = sha256Digest({
    schemaVersion: 1, shopifyProductGid: identity.shopifyProductGid,
    shopifyVariantGid: identity.shopifyVariantGid, rawSku: identity.rawSku, fields: source,
  });
  const ebayDigest = sha256Digest({
    schemaVersion: 1, ebaySellerId: identity.ebaySellerId,
    ebayMarketplaceId: identity.ebayMarketplaceId, managementModel,
    ebayInventorySku: identity.ebayInventorySku, ebayOfferId: identity.ebayOfferId,
    ebayListingId: identity.ebayListingId, fields: observed,
  });
  return Object.freeze({
    workspace, identity, source: Object.freeze(source), observed: Object.freeze(observed),
    sourceDigest, ebayDigest,
    ebayObservedAtUtc: workspace.evidence.detailObservedAtUtc
      ?? workspace.evidence.catalogObservedAtUtc,
  });
}

const FIELD_DIGEST = {
  source(value: string | null) {
    return sha256Digest({ state: value === null ? 'missing' : 'value', value });
  },
  observed(value: string | null) {
    return sha256Digest({ state: value === null ? 'unavailable' : 'value', value });
  },
  empty() { return sha256Digest({ state: 'not_set', value: null }); },
  proposed(value: string | null) {
    return sha256Digest({ state: value === null ? 'omitted' : 'value', value });
  },
} as const;

const EDITABLE: Readonly<Record<ListingFieldName, boolean>> = Object.freeze({
  title: true, category: true, condition: true, condition_description: true,
  price: false, quantity: false, description: true, images: true,
  item_specifics: false, identifiers: false, fulfillment_policy: true,
  payment_policy: true, return_policy: true, merchant_location: true,
});

type DraftValues = Partial<Record<ListingFieldName, string | null>>;

function fieldsForRevision(basis: Basis, draft: DraftValues): ListingFieldInput[] {
  return (Object.keys(EDITABLE) as ListingFieldName[]).map((field) => {
    const sourceValue = basis.source[field];
    const observedValue = basis.observed[field];
    const submitted = EDITABLE[field] ? (draft[field] ?? null) : null;
    const hasRemoteListing = basis.identity.ebayListingId !== null;
    const inherited = hasRemoteListing ? (observedValue ?? sourceValue) : sourceValue;
    const proposedValue = submitted === null ? inherited : submitted;
    const proposedSource: ListingFieldInput['proposedSource'] = proposedValue === null
      ? 'omit'
      : submitted !== null
        ? hasRemoteListing
          ? submitted === observedValue ? 'observed' : 'override'
          : submitted === sourceValue ? 'source' : 'override'
        : hasRemoteListing && proposedValue === observedValue ? 'observed'
          : proposedValue === sourceValue ? 'source'
            : proposedValue === observedValue ? 'observed' : 'override';
    const overrideValue = proposedSource === 'override' ? proposedValue : null;
    return Object.freeze({
      field, sourceValue, sourceDigest: FIELD_DIGEST.source(sourceValue),
      defaultValue: null, defaultDigest: FIELD_DIGEST.empty(),
      overrideValue, overrideDigest: overrideValue === null
        ? FIELD_DIGEST.empty() : sha256Digest({ state: 'value', value: overrideValue }),
      proposedValue, proposedDigest: FIELD_DIGEST.proposed(proposedValue), proposedSource,
      observedValue, observedDigest: FIELD_DIGEST.observed(observedValue),
    });
  });
}

function currentDraft(revision: ListingRevision | null, field: ListingFieldName): string | null {
  const stored = revision?.fields.find((candidate) => candidate.field === field);
  return stored?.proposedSource === 'override' ? stored.overrideValue : null;
}

function overrideMap(fields: readonly ListingFieldInput[]): string {
  return JSON.stringify(Object.fromEntries(fields.filter((field) => EDITABLE[field.field]).map(
    (field) => [field.field, field.proposedSource === 'override' ? field.overrideValue : null],
  )));
}

function leaf(basis: Basis, revision: ListingRevision | null, field: ListingFieldName): ListingDraftField {
  return Object.freeze({
    shopify: basis.source[field], ebay: basis.observed[field],
    draft: currentDraft(revision, field), editable: EDITABLE[field],
  });
}

function dto(
  basis: Basis,
  revision: ListingRevision | null,
  saveDraft: boolean,
): ListingDraftDto {
  return Object.freeze({
    schemaVersion: 1 as const, mode: 'local_draft_only' as const,
    catalogId: basis.workspace.catalog.id, identity: basis.identity,
    base: Object.freeze({
      catalogObservedAtUtc: basis.workspace.evidence.catalogObservedAtUtc,
      detailObservedAtUtc: basis.workspace.evidence.detailObservedAtUtc,
      sourceDigest: basis.sourceDigest, ebayDigest: basis.ebayDigest,
    }),
    revision: revision ? Object.freeze({
      revisionId: revision.revisionId, revisionNumber: revision.revisionNumber,
      revisionDigest: revision.revisionDigest, state: 'draft' as const,
      createdAtUtc: revision.createdAtUtc,
    }) : null,
    sections: Object.freeze({
      listing: Object.freeze({
        title: leaf(basis, revision, 'title'), category: leaf(basis, revision, 'category'),
        condition: leaf(basis, revision, 'condition'),
        conditionDescription: leaf(basis, revision, 'condition_description'),
        price: leaf(basis, revision, 'price'), quantity: leaf(basis, revision, 'quantity'),
      }),
      content: Object.freeze({
        description: leaf(basis, revision, 'description'), images: leaf(basis, revision, 'images'),
        itemSpecifics: leaf(basis, revision, 'item_specifics'),
        identifiers: leaf(basis, revision, 'identifiers'),
      }),
      delivery: Object.freeze({
        fulfillmentPolicyId: leaf(basis, revision, 'fulfillment_policy'),
        paymentPolicyId: leaf(basis, revision, 'payment_policy'),
        returnPolicyId: leaf(basis, revision, 'return_policy'),
        merchantLocation: leaf(basis, revision, 'merchant_location'),
      }),
    }),
    capabilities: Object.freeze({ saveDraft, previewChanges: true,
      apply: false as const, publish: false as const }),
    externalWritesPerformed: 0 as const,
  });
}

export type ListingDraftServiceDependencies = Readonly<{
  readWorkspace?: (catalogId: string) => Promise<ListingWorkspaceDto>;
  databasePath?: () => string | undefined;
  openReadOnly?: typeof openListingControlStoreReadOnly;
  openWritable?: typeof openListingControlStore;
  now?: () => Date;
  uuid?: () => string;
  writerInstanceReady?: () => boolean;
}>;

function translate(error: unknown): never {
  if (error instanceof ListingDraftServiceError) throw error;
  if (error instanceof ListingWorkspaceReaderError && error.kind === 'not_found') {
    throw new ListingDraftServiceError('LISTING_DRAFT_NOT_FOUND');
  }
  if (error instanceof ListingControlStoreError
    && ['CONFLICT', 'STALE_BASE'].includes(error.code)) {
    throw new ListingDraftServiceError('LISTING_DRAFT_STALE');
  }
  return unavailable();
}

export function createListingDraftService(dependencies: ListingDraftServiceDependencies = {}) {
  const readWorkspace = dependencies.readWorkspace ?? readListingWorkspace;
  const databasePath = dependencies.databasePath ?? (() => process.env.LISTING_CONTROL_DATABASE_PATH);
  const openReadOnly = dependencies.openReadOnly ?? openListingControlStoreReadOnly;
  const openWritable = dependencies.openWritable ?? openListingControlStore;
  const now = dependencies.now ?? (() => new Date());
  const uuid = dependencies.uuid ?? randomUUID;
  const writerInstanceReady = dependencies.writerInstanceReady ?? (() => {
    return process.env.LISTING_CONTROL_SINGLE_WRITER_ACK === LISTING_DRAFT_SINGLE_WRITER_ACK;
  });

  function path(): string {
    const value = databasePath();
    if (typeof value !== 'string' || value.length === 0) return unavailable();
    return value;
  }
  function preflight(): void {
    const store = openReadOnly({ databasePath: path(), expectedScope: LISTING_DRAFT_SCOPE });
    store.close();
  }

  return Object.freeze({
    async get(catalogId: string, saveAuthorized = false): Promise<ListingDraftDto> {
      if (!CATALOG_ID.test(catalogId)) invalid();
      try {
        preflight();
        const basis = eligibleBasis(await readWorkspace(catalogId));
        const store = openReadOnly({ databasePath: path(), expectedScope: LISTING_DRAFT_SCOPE });
        try {
          return dto(basis, store.getLatestRevision(basis.identity.shopifyVariantGid),
            saveAuthorized && writerInstanceReady());
        }
        finally { store.close(); }
      } catch (error) { return translate(error); }
    },

    async save(request: SaveListingDraftRequest, actor: string): Promise<ListingDraftDto> {
      try {
        if (!writerInstanceReady()) unavailable();
        preflight();
        const basis = eligibleBasis(await readWorkspace(request.catalogId));
        if (request.base.sourceDigest !== basis.sourceDigest
          || request.base.ebayDigest !== basis.ebayDigest) {
          throw new ListingDraftServiceError('LISTING_DRAFT_STALE');
        }
        const store = openWritable({ databasePath: path(), expectedScope: LISTING_DRAFT_SCOPE });
        try {
          const previous = store.getLatestRevision(basis.identity.shopifyVariantGid);
          if (request.expectedRevisionDigest !== (previous?.revisionDigest ?? null)) {
            throw new ListingDraftServiceError('LISTING_DRAFT_STALE');
          }
          const draft: DraftValues = {
            title: request.draft.title, category: request.draft.category,
            condition: request.draft.condition,
            condition_description: request.draft.conditionDescription,
            description: request.draft.description, images: request.draft.images,
            fulfillment_policy: request.draft.fulfillmentPolicyId,
            payment_policy: request.draft.paymentPolicyId,
            return_policy: request.draft.returnPolicyId,
            merchant_location: request.draft.merchantLocation,
          };
          const fields = fieldsForRevision(basis, draft);
          const noOverrides = overrideMap(fields) === overrideMap(fieldsForRevision(basis, {}));
          if ((previous === null && noOverrides)
            || (previous !== null && overrideMap(fields) === overrideMap(previous.fields))) {
            throw new ListingDraftServiceError('LISTING_DRAFT_INVALID');
          }
          const bases = deriveListingBaseDigests({
            scope: LISTING_DRAFT_SCOPE, identity: basis.identity,
            baseSourceObservedAtUtc: basis.workspace.evidence.catalogObservedAtUtc,
            baseEbayObservedAtUtc: basis.ebayObservedAtUtc, fields,
          });
          const createdAtUtc = now().toISOString();
          const nonce = uuid();
          const created = store.createRevision({
            revisionId: `listing-draft:${nonce}`, identity: basis.identity,
            baseSourceDigest: bases.source,
            baseSourceObservedAtUtc: basis.workspace.evidence.catalogObservedAtUtc,
            baseEbayObservationDigest: bases.ebay,
            baseEbayObservedAtUtc: basis.ebayObservedAtUtc,
            fields, actor, state: 'draft', createdAtUtc,
            expectedPreviousRevisionDigest: previous?.revisionDigest ?? null,
            expectedLatestBaseSourceDigest: previous?.baseSourceDigest ?? null,
            expectedLatestBaseEbayObservationDigest: previous?.baseEbayObservationDigest ?? null,
            auditEventId: `listing-draft-event:${nonce}`,
          });
          return dto(basis, created, true);
        } finally { store.close(); }
      } catch (error) { return translate(error); }
    },
  });
}

export type ListingDraftService = ReturnType<typeof createListingDraftService>;

export const LISTING_DRAFT_SERVICE_TESTING = Object.freeze({
  eligibleBasis, fieldsForRevision, canonicalImages, htmlToPlainText, canonicalJson,
});
