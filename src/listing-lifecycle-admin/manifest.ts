/**
 * Pure manifest derivation for the isolated listing-lifecycle operator CLI
 * (listing CREATE from an approved local draft of a not-listed item, and
 * listing END for an active listing). No store, network, credential, or
 * provider access happens here.
 *
 * The CREATE manifest derives deterministically from one approved local draft
 * revision alone, so the same revision always yields the same manifest
 * digest — before dispatch, during dispatch, and during any later
 * reconciliation. For a not-listed (unmanaged) item the revision's observed
 * values are all null and the source values rule: the proposed values ARE the
 * listing, and price/quantity come from the revision's Shopify source values
 * because a new listing needs an initial price and quantity and Marketplace
 * Connect has no claim on a listing it never knew.
 *
 * The END manifest derives from one fresh workspace basis (there is no draft
 * revision for an end): identity, the single supported ending reason, and a
 * digest of the observed title binding the manifest to the reviewed state.
 *
 * Relist is deliberately not a separate code path: it is a re-run of the
 * create ceremony against the then-not-listed item.
 */
import {
  sha256Digest,
  type Digest,
  type ListingFieldName,
  type ListingIdentity,
  type ListingRevision,
} from '../listing-control-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../listing-control-config.js';
import type { ListingDraftBasis } from '../server/listing-draft-service.js';
import {
  LISTING_DESCRIPTION_TEMPLATE_VERSION,
  ListingDescriptionTemplateError,
  renderListingDescription,
} from '../server/listing-description-template.js';
import type { ListingWorkspaceDto } from '../server/listing-workspace-reader.js';

export class ListingLifecycleManifestError extends Error {
  constructor(readonly code:
    | 'CREATE_TARGET_ALREADY_LISTED'
    | 'CREATE_REQUIRED_FIELD_MISSING'
    | 'CREATE_CONDITION_UNSUPPORTED'
    | 'CREATE_IDENTITY_MISMATCH'
    | 'CREATE_BASE_STALE'
    | 'CREATE_PAYLOAD_INVALID'
    | 'CREATE_TEMPLATE_UNSUPPORTED'
    | 'CREATE_TEMPLATE_INPUT_INVALID'
    | 'CREATE_TEMPLATE_OUTPUT_TOO_LARGE'
    | 'CREATE_INVENTORY_PRODUCT_DESCRIPTION_TOO_LARGE'
    | 'CREATE_LISTING_DESCRIPTION_TOO_LARGE'
    | 'CREATE_ITEM_SPECIFICS_INVALID'
    | 'CREATE_PREVALIDATION_CATEGORY_ID'
    | 'CREATE_PREVALIDATION_CONDITION'
    | 'CREATE_PREVALIDATION_POLICY_IDS'
    | 'CREATE_PREVALIDATION_MERCHANT_LOCATION'
    | 'CREATE_PREVALIDATION_ASPECTS'
    | 'CREATE_PREVALIDATION_LISTING_DURATION'
    | 'CREATE_PREVALIDATION_INVENTORY_DESCRIPTION'
    | 'CREATE_PREVALIDATION_LISTING_DESCRIPTION'
    | 'END_TARGET_NOT_ACTIVE'
    | 'END_REASON_UNSUPPORTED',
  readonly field: ListingFieldName | null = null) {
    super('Listing lifecycle manifest derivation failed');
    this.name = 'ListingLifecycleManifestError';
  }
}

const deny = (
  code: ConstructorParameters<typeof ListingLifecycleManifestError>[0],
  field: ListingFieldName | null = null,
): never => {
  throw new ListingLifecycleManifestError(code, field);
};

/**
 * FIXED mapping from the draft model's numeric eBay condition IDs to the
 * Inventory API condition enums. Any other numeric ID fails closed as
 * CREATE_CONDITION_UNSUPPORTED — no fuzzy or default mapping exists.
 */
export const CREATE_CONDITION_ENUM_BY_ID: Readonly<Record<string, string>> = Object.freeze({
  '1000': 'NEW',
  '1500': 'NEW_OTHER',
  '1750': 'NEW_WITH_DEFECTS',
  '2000': 'CERTIFIED_REFURBISHED',
  '2500': 'SELLER_REFURBISHED',
  '2750': 'LIKE_NEW',
  '3000': 'USED_EXCELLENT',
  '4000': 'USED_VERY_GOOD',
  '5000': 'USED_GOOD',
  '6000': 'USED_ACCEPTABLE',
  '7000': 'FOR_PARTS_OR_NOT_WORKING',
});

/**
 * Fixed required-or-deny field list for a create. A missing value denies with
 * CREATE_REQUIRED_FIELD_MISSING naming the field (values stay redacted).
 * `quantity` additionally requires an integer of at least one, and `price` a
 * parseable {amount, currency} money value.
 */
export const CREATE_REQUIRED_FIELDS = Object.freeze([
  'title',
  'category',
  'condition',
  'description',
  'item_specifics',
  'price',
  'quantity',
  'fulfillment_policy',
  'payment_policy',
  'return_policy',
  'merchant_location',
  'images',
] as const satisfies readonly ListingFieldName[]);

export const END_SUPPORTED_REASON = 'not-available' as const;

/** eBay Inventory API Product.description maximum, including markup. */
export const MAX_INVENTORY_PRODUCT_DESCRIPTION_LENGTH = 4_000;
export const MAX_OFFER_LISTING_DESCRIPTION_LENGTH = 500_000;

export type ListingCreateManifest = Readonly<{
  schemaVersion: 2;
  scope: typeof LISTING_DRAFT_SCOPE;
  action: 'create_ebay_listing';
  descriptionPlacement: 'inventory_product_and_offer_listing_split';
  identity: ListingIdentity;
  revisionId: string;
  revisionNumber: number;
  revisionDigest: Digest;
  baseSourceDigest: Digest;
  baseEbayObservationDigest: Digest;
  proposed: Readonly<{
    title: string;
    categoryId: string;
    conditionId: string;
    conditionEnum: string;
    conditionDescription: string | null;
    /** Exact full buyer-facing HTML serialized only as Offer.listingDescription. */
    description: string;
    /**
     * Exact approved pre-template product description serialized as
     * InventoryItem.product.description. It is separately bounded by eBay's
     * 4,000-character Inventory contract and is never derived by truncating
     * the buyer-facing listing HTML.
     */
    inventoryProductDescription: string;
    images: readonly string[];
    aspects: Readonly<Record<string, readonly string[]>>;
    fulfillmentPolicyId: string;
    paymentPolicyId: string;
    returnPolicyId: string;
    merchantLocationKey: string;
    price: Readonly<{ amount: string; currency: string }>;
    quantity: number;
    listingDuration: 'GTC';
  }>;
}>;

export type DerivedListingCreateManifest = Readonly<{
  manifest: ListingCreateManifest;
  manifestDigest: Digest;
}>;

export type TemplatedListingCreateManifest = Readonly<{
  manifest: ListingCreateManifest;
  manifestDigest: Digest;
  descriptionTemplateApplied: boolean;
}>;

export type ListingEndManifest = Readonly<{
  schemaVersion: 1;
  scope: typeof LISTING_DRAFT_SCOPE;
  identity: ListingIdentity;
  action: 'end_listing';
  reason: typeof END_SUPPORTED_REASON;
  observedTitleDigest: Digest;
}>;

export type DerivedListingEndManifest = Readonly<{
  manifest: ListingEndManifest;
  manifestDigest: Digest;
}>;

function revisionField(revision: ListingRevision, field: ListingFieldName) {
  return revision.fields.find((candidate) => candidate.field === field) ?? null;
}

function proposedValue(revision: ListingRevision, field: ListingFieldName): string | null {
  return revisionField(revision, field)?.proposedValue ?? null;
}

function requireProposed(revision: ListingRevision, field: ListingFieldName): string {
  const value = proposedValue(revision, field);
  if (value === null || value.length === 0) deny('CREATE_REQUIRED_FIELD_MISSING', field);
  return value as string;
}

function parseImageList(serialized: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return deny('CREATE_REQUIRED_FIELD_MISSING', 'images');
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 24
    || parsed.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    return deny('CREATE_REQUIRED_FIELD_MISSING', 'images');
  }
  return parsed as string[];
}

function parseItemSpecifics(serialized: string): Readonly<Record<string, readonly string[]>> {
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); } catch { return deny('CREATE_ITEM_SPECIFICS_INVALID'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return deny('CREATE_ITEM_SPECIFICS_INVALID');
  }
  const record = parsed as Record<string, unknown>;
  const names = Object.keys(record);
  if (names.length === 0 || names.length > 50 || names.join(',') !== [...names].sort().join(',')) {
    return deny('CREATE_ITEM_SPECIFICS_INVALID');
  }
  const canonicalNames = new Set<string>();
  const result: Record<string, readonly string[]> = {};
  for (const name of names) {
    const values = record[name];
    const foldedName = name.toLocaleLowerCase('en-US');
    if (name.length === 0 || name.length > 65 || name.trim() !== name
      || canonicalNames.has(foldedName) || !Array.isArray(values)
      || values.length === 0 || values.length > 30) return deny('CREATE_ITEM_SPECIFICS_INVALID');
    canonicalNames.add(foldedName);
    const seenValues = new Set<string>();
    const checked = values.map((entry) => {
      if (typeof entry !== 'string' || entry.length === 0 || entry.length > 65
        || entry.trim() !== entry || seenValues.has(entry)) {
        return deny('CREATE_ITEM_SPECIFICS_INVALID');
      }
      seenValues.add(entry);
      return entry;
    });
    result[name] = Object.freeze(checked);
  }
  return Object.freeze(result);
}

function parseMoney(serialized: string): { amount: string; currency: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return deny('CREATE_REQUIRED_FIELD_MISSING', 'price');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return deny('CREATE_REQUIRED_FIELD_MISSING', 'price');
  }
  const record = parsed as Record<string, unknown>;
  const amount = record.amount;
  const currency = record.currency;
  if (Object.keys(record).sort().join(',') !== 'amount,currency'
    || typeof amount !== 'string' || !/^[0-9]+(\.[0-9]+)?$/.test(amount)
    || Number(amount) <= 0
    || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    return deny('CREATE_REQUIRED_FIELD_MISSING', 'price');
  }
  return { amount, currency };
}

function parseQuantity(serialized: string): number {
  if (!/^[0-9]{1,9}$/.test(serialized)) deny('CREATE_REQUIRED_FIELD_MISSING', 'quantity');
  const quantity = Number(serialized);
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    deny('CREATE_REQUIRED_FIELD_MISSING', 'quantity');
  }
  return quantity;
}

function inventoryProductDescription(description: string): string {
  if (description.length > MAX_INVENTORY_PRODUCT_DESCRIPTION_LENGTH) {
    deny('CREATE_INVENTORY_PRODUCT_DESCRIPTION_TOO_LARGE', 'description');
  }
  return description;
}

function listingDescription(description: string): string {
  if (description.length > MAX_OFFER_LISTING_DESCRIPTION_LENGTH) {
    deny('CREATE_LISTING_DESCRIPTION_TOO_LARGE', 'description');
  }
  return description;
}

function assertUnmanagedIdentity(identity: ListingIdentity): void {
  if (identity.managementModel !== 'unmanaged'
    || identity.ebayInventorySku !== null
    || identity.ebayOfferId !== null
    || identity.ebayListingId !== null) {
    deny('CREATE_TARGET_ALREADY_LISTED');
  }
}

/**
 * Derive the deterministic CREATE manifest from one stored draft revision of
 * a not-listed (unmanaged) item. For a create the proposed values ARE the
 * listing; price and quantity are taken from the revision's Shopify SOURCE
 * values. Every required field must be present, the condition ID must map
 * through the fixed table, and any eBay artifact on the identity denies as
 * already-listed.
 */
export function deriveListingCreateManifest(
  revision: ListingRevision,
): DerivedListingCreateManifest {
  assertUnmanagedIdentity(revision.identity);

  const title = requireProposed(revision, 'title');
  const categoryId = requireProposed(revision, 'category');
  const conditionId = requireProposed(revision, 'condition');
  const conditionEnum = CREATE_CONDITION_ENUM_BY_ID[conditionId]
    ?? deny('CREATE_CONDITION_UNSUPPORTED');
  const fulfillmentPolicyId = requireProposed(revision, 'fulfillment_policy');
  const paymentPolicyId = requireProposed(revision, 'payment_policy');
  const returnPolicyId = requireProposed(revision, 'return_policy');
  const merchantLocationKey = requireProposed(revision, 'merchant_location');
  const images = parseImageList(requireProposed(revision, 'images'));
  const description = requireProposed(revision, 'description');
  const aspects = parseItemSpecifics(requireProposed(revision, 'item_specifics'));
  if (revision.identity.rawSku.length > 50) deny('CREATE_IDENTITY_MISMATCH');
  if (title.length > 80) deny('CREATE_REQUIRED_FIELD_MISSING', 'title');

  const priceSource = revisionField(revision, 'price')?.sourceValue ?? null;
  if (priceSource === null) deny('CREATE_REQUIRED_FIELD_MISSING', 'price');
  const price = parseMoney(priceSource as string);
  const quantitySource = revisionField(revision, 'quantity')?.sourceValue ?? null;
  if (quantitySource === null) deny('CREATE_REQUIRED_FIELD_MISSING', 'quantity');
  const quantity = parseQuantity(quantitySource as string);

  const manifest: ListingCreateManifest = Object.freeze({
    schemaVersion: 2 as const,
    scope: LISTING_DRAFT_SCOPE,
    action: 'create_ebay_listing' as const,
    descriptionPlacement: 'inventory_product_and_offer_listing_split' as const,
    identity: revision.identity,
    revisionId: revision.revisionId,
    revisionNumber: revision.revisionNumber,
    revisionDigest: revision.revisionDigest,
    baseSourceDigest: revision.baseSourceDigest,
    baseEbayObservationDigest: revision.baseEbayObservationDigest,
    proposed: Object.freeze({
      title,
      categoryId,
      conditionId,
      conditionEnum,
      conditionDescription: proposedValue(revision, 'condition_description'),
      description: listingDescription(description),
      inventoryProductDescription: inventoryProductDescription(description),
      images: Object.freeze(images),
      aspects,
      fulfillmentPolicyId,
      paymentPolicyId,
      returnPolicyId,
      merchantLocationKey,
      price: Object.freeze(price),
      quantity,
      listingDuration: 'GTC' as const,
    }),
  });
  return Object.freeze({ manifest, manifestDigest: sha256Digest(manifest) });
}

/**
 * Opt-in create templating mirrors the listing-revise ceremony: the rendered
 * HTML derives only from the approved revision/manifest, replaces only the
 * buyer-facing proposed description, and is therefore bound into a new
 * deterministic manifest digest. The separately bound Inventory product
 * description remains the exact approved pre-template description; the
 * template is never truncated into eBay's smaller Product.description field.
 */
export function applyListingCreateDescriptionTemplate(input: {
  derived: DerivedListingCreateManifest;
  revision: ListingRevision;
  templateVersion: string;
}): TemplatedListingCreateManifest {
  if (input.templateVersion !== LISTING_DESCRIPTION_TEMPLATE_VERSION) {
    deny('CREATE_TEMPLATE_UNSUPPORTED');
  }
  const { manifest } = input.derived;
  let rendered = '';
  try {
    rendered = renderListingDescription({
      templateVersion: LISTING_DESCRIPTION_TEMPLATE_VERSION,
      title: manifest.proposed.title,
      bodyHtml: manifest.proposed.description,
      conditionId: manifest.proposed.conditionId,
      conditionNote: manifest.proposed.conditionDescription,
      imageUrls: manifest.proposed.images,
      sku: input.revision.identity.rawSku,
    });
  } catch (error) {
    if (error instanceof ListingDescriptionTemplateError) {
      deny(error.code === 'OUTPUT_TOO_LARGE'
        ? 'CREATE_TEMPLATE_OUTPUT_TOO_LARGE'
        : 'CREATE_TEMPLATE_INPUT_INVALID');
    }
    throw error;
  }
  const templatedManifest: ListingCreateManifest = Object.freeze({
    ...manifest,
    proposed: Object.freeze({ ...manifest.proposed, description: listingDescription(rendered) }),
  });
  return Object.freeze({
    manifest: templatedManifest,
    manifestDigest: sha256Digest(templatedManifest),
    descriptionTemplateApplied: true,
  });
}

/** eBay leaf category ids are plain positive decimal integers. */
const PREVALIDATION_CATEGORY_ID = /^[1-9][0-9]{0,9}$/;
/** eBay business policy ids are plain positive decimal integers. */
const PREVALIDATION_POLICY_ID = /^[1-9][0-9]{0,18}$/;
/**
 * eBay merchant location keys: at most 36 characters, no spaces or exotic
 * characters (the draft store's safe-identifier charset, capped at eBay's
 * documented 36-character maximum).
 */
const PREVALIDATION_MERCHANT_LOCATION_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,35}$/;

/**
 * Bounded local pre-publish validation (Brain L30/L34): before ANY provider
 * write, prove with fixed codes the documented publish prerequisites that
 * eBay's opaque post-hoc `25019` rejection will never name. Every check runs
 * against local data only; each failure is its own fixed
 * `CREATE_PREVALIDATION_*` code naming the field family, and no provider
 * text, value, or URL is ever echoed. This runs at preflight and again at
 * dispatch (on the final, template-applied manifest) — it is deliberately not
 * part of recovery reconciliation, which must be able to reconcile a
 * historical job regardless of newer validation rules (L32).
 */
export function prevalidateListingCreateManifest(manifest: ListingCreateManifest): void {
  const { proposed } = manifest;
  if (!PREVALIDATION_CATEGORY_ID.test(proposed.categoryId)) {
    deny('CREATE_PREVALIDATION_CATEGORY_ID', 'category');
  }
  if (CREATE_CONDITION_ENUM_BY_ID[proposed.conditionId] !== proposed.conditionEnum
    || proposed.conditionEnum.length === 0) {
    deny('CREATE_PREVALIDATION_CONDITION', 'condition');
  }
  if (!PREVALIDATION_POLICY_ID.test(proposed.fulfillmentPolicyId)) {
    deny('CREATE_PREVALIDATION_POLICY_IDS', 'fulfillment_policy');
  }
  if (!PREVALIDATION_POLICY_ID.test(proposed.paymentPolicyId)) {
    deny('CREATE_PREVALIDATION_POLICY_IDS', 'payment_policy');
  }
  if (!PREVALIDATION_POLICY_ID.test(proposed.returnPolicyId)) {
    deny('CREATE_PREVALIDATION_POLICY_IDS', 'return_policy');
  }
  if (!PREVALIDATION_MERCHANT_LOCATION_KEY.test(proposed.merchantLocationKey)) {
    deny('CREATE_PREVALIDATION_MERCHANT_LOCATION', 'merchant_location');
  }
  const aspectNames = Object.keys(proposed.aspects);
  if (aspectNames.length === 0
    || aspectNames.some((name) => proposed.aspects[name]!.length === 0)) {
    deny('CREATE_PREVALIDATION_ASPECTS', 'item_specifics');
  }
  if (proposed.listingDuration !== 'GTC') {
    deny('CREATE_PREVALIDATION_LISTING_DURATION');
  }
  if (proposed.inventoryProductDescription.length === 0
    || proposed.inventoryProductDescription.length > MAX_INVENTORY_PRODUCT_DESCRIPTION_LENGTH) {
    deny('CREATE_PREVALIDATION_INVENTORY_DESCRIPTION', 'description');
  }
  if (proposed.description.length === 0
    || proposed.description.length > MAX_OFFER_LISTING_DESCRIPTION_LENGTH) {
    deny('CREATE_PREVALIDATION_LISTING_DESCRIPTION', 'description');
  }
}

function identitiesMatch(left: ListingIdentity, right: ListingIdentity): boolean {
  return left.shopifyProductGid === right.shopifyProductGid
    && left.shopifyVariantGid === right.shopifyVariantGid
    && left.rawSku === right.rawSku
    && left.ebaySellerId === right.ebaySellerId
    && left.ebayMarketplaceId === right.ebayMarketplaceId
    && left.managementModel === right.managementModel
    && left.ebayInventorySku === right.ebayInventorySku
    && left.ebayOfferId === right.ebayOfferId
    && left.ebayListingId === right.ebayListingId;
}

/**
 * Pre-dispatch freshness gate for a create: the live workspace identity must
 * equal the revision identity, and both the observed values (all null for an
 * unmanaged item — any appearing eBay artifact is drift) AND the Shopify
 * source values must still match the revision. Because a create takes price
 * and quantity from the source values, Shopify drift in them stales the
 * draft and denies dispatch.
 */
export function assertFreshBasisMatchesCreateRevision(input: {
  revision: ListingRevision;
  freshBasis: ListingDraftBasis;
}): void {
  if (!identitiesMatch(input.freshBasis.identity, input.revision.identity)) {
    deny('CREATE_IDENTITY_MISMATCH');
  }
  for (const field of input.revision.fields) {
    const freshObserved = input.freshBasis.observed[field.field] ?? null;
    if (freshObserved !== field.observedValue) deny('CREATE_BASE_STALE');
    const freshSource = input.freshBasis.source[field.field] ?? null;
    if (freshSource !== field.sourceValue) deny('CREATE_BASE_STALE');
  }
}

export type ListingCreatePayloads = Readonly<{
  inventoryItemPayload: Record<string, unknown>;
  offerPayload: Record<string, unknown>;
}>;

/**
 * Derive the exact two provider payloads from the manifest alone: the
 * Inventory-item PUT body and the Offer POST body. Nothing outside the
 * manifest's proposed values is ever serialized.
 */
export function buildListingCreatePayloads(manifest: ListingCreateManifest): ListingCreatePayloads {
  if (manifest.schemaVersion !== 2 || manifest.action !== 'create_ebay_listing') {
    deny('CREATE_PAYLOAD_INVALID');
  }
  const { proposed } = manifest;
  const product: Record<string, unknown> = {
    title: proposed.title,
    imageUrls: [...proposed.images],
    description: proposed.inventoryProductDescription,
    aspects: proposed.aspects,
  };
  const inventoryItemPayload: Record<string, unknown> = {
    product,
    condition: proposed.conditionEnum,
    availability: { shipToLocationAvailability: { quantity: proposed.quantity } },
  };
  if (proposed.conditionDescription !== null) {
    inventoryItemPayload.conditionDescription = proposed.conditionDescription;
  }
  const offerPayload: Record<string, unknown> = {
    sku: manifest.identity.rawSku,
    marketplaceId: manifest.scope.ebayMarketplaceId,
    format: 'FIXED_PRICE',
    availableQuantity: proposed.quantity,
    categoryId: proposed.categoryId,
    listingPolicies: {
      fulfillmentPolicyId: proposed.fulfillmentPolicyId,
      paymentPolicyId: proposed.paymentPolicyId,
      returnPolicyId: proposed.returnPolicyId,
    },
    pricingSummary: {
      price: { value: proposed.price.amount, currency: proposed.price.currency },
    },
    merchantLocationKey: proposed.merchantLocationKey,
    listingDuration: proposed.listingDuration,
  };
  offerPayload.listingDescription = proposed.description;
  return Object.freeze({ inventoryItemPayload, offerPayload });
}

/**
 * Derive the deterministic END manifest from one fresh basis. The target must
 * be an ACTIVE listing under either management model, and the only supported
 * ending reason is `not-available` (eBay Trading `NotAvailable` / Inventory
 * offer withdraw).
 */
export function deriveListingEndManifest(input: {
  basis: ListingDraftBasis;
  reason: string;
}): DerivedListingEndManifest {
  if (input.reason !== END_SUPPORTED_REASON) deny('END_REASON_UNSUPPORTED');
  const identity = input.basis.identity;
  const inventoryManaged = identity.managementModel === 'inventory_api'
    && identity.ebayInventorySku !== null
    && identity.ebayOfferId !== null
    && identity.ebayListingId !== null;
  const tradingManaged = identity.managementModel === 'trading_api'
    && identity.ebayInventorySku === null
    && identity.ebayOfferId === null
    && identity.ebayListingId !== null;
  if (!inventoryManaged && !tradingManaged) deny('END_TARGET_NOT_ACTIVE');
  const observedTitle = input.basis.observed.title;
  const manifest: ListingEndManifest = Object.freeze({
    schemaVersion: 1 as const,
    scope: LISTING_DRAFT_SCOPE,
    identity,
    action: 'end_listing' as const,
    reason: END_SUPPORTED_REASON,
    observedTitleDigest: sha256Digest({
      state: observedTitle === null ? 'unavailable' : 'value',
      value: observedTitle,
    }),
  });
  return Object.freeze({ manifest, manifestDigest: sha256Digest(manifest) });
}

/**
 * Post-dispatch outcome classification over one fresh raw workspace read (a
 * fresh read performs a new capture). Deliberately NOT the strict
 * draft-eligibility basis: the in-between states this classifier must name —
 * an unpublished offer artifact, an ambiguous capture — are exactly the
 * states the eligibility gate refuses.
 *
 * - `observed`: the intended terminal state is visible and bound.
 * - `absent`: the pre-dispatch state is still visible unchanged.
 * - `artifact` (create only): an offer/unpublished artifact exists without an
 *   active listing — the created-offer-but-publish-failed case. Never
 *   resolvable, not even with --accept-absent: a remote artifact exists. The
 *   operator finishes or withdraws it in a new ceremony.
 * - `unverified`: the capture is ambiguous; never resolvable.
 */
export type LifecycleOutcomeKind = 'observed' | 'absent' | 'artifact' | 'unverified';

export type LifecycleOutcome = Readonly<{
  kind: LifecycleOutcomeKind;
  observedListingId: string | null;
  observedOfferId: string | null;
  observedDigest: Digest;
}>;

function workspaceRowDigest(workspace: ListingWorkspaceDto): Digest {
  const row = workspace.catalog;
  const rawDescription = workspace.ebayDetail?.actual.content.descriptionHtml ?? null;
  return sha256Digest({
    schemaVersion: 1,
    lifecycleStatus: row.lifecycleStatus,
    listingId: row.ebay.listingId,
    offerId: row.ebay.offerId,
    activeMatchCount: row.ebay.activeMatchCount,
    inventoryItemCount: row.ebay.inventoryItemCount,
    offerCount: row.ebay.offerCount,
    unpublishedArtifactCount: row.ebay.unpublishedArtifactCount,
    rawDescriptionDigest: sha256Digest({
      state: rawDescription === null ? 'unavailable' : 'value',
      value: rawDescription === null ? null : rawDescription.replace(/\r\n?/gu, '\n'),
    }),
    observedAtUtc: workspace.evidence.catalogObservedAtUtc,
  });
}

function outcome(workspace: ListingWorkspaceDto, kind: LifecycleOutcomeKind): LifecycleOutcome {
  return Object.freeze({
    kind,
    observedListingId: workspace.catalog.ebay.listingId,
    observedOfferId: workspace.catalog.ebay.offerId,
    observedDigest: workspaceRowDigest(workspace),
  });
}

function captureBound(workspace: ListingWorkspaceDto, sku: string): boolean {
  const row = workspace.catalog;
  return workspace.schemaVersion === 1
    && workspace.evidence.freshness === 'live'
    && workspace.evidence.externalWritesPerformed === 0
    && row.audit.verified === true
    && row.shopify !== null
    && row.shopify.sku === sku
    && row.ebay.sku === sku;
}

export function classifyCreateOutcome(input: {
  workspace: ListingWorkspaceDto;
  sku: string;
  expectedListingId: string | null;
  expectedDescriptionHtml: string | null;
}): LifecycleOutcome {
  const { workspace } = input;
  if (!captureBound(workspace, input.sku)) return outcome(workspace, 'unverified');
  const row = workspace.catalog;
  if (row.lifecycleStatus === 'active'
    && row.ebay.listingId !== null
    && row.ebay.offerId !== null
    && row.ebay.activeMatchCount === 1) {
    if (input.expectedListingId !== null && row.ebay.listingId !== input.expectedListingId) {
      return outcome(workspace, 'unverified');
    }
    if (workspace.ebayDetail === null) return outcome(workspace, 'unverified');
    const rawDescription = workspace.ebayDetail.actual.content.descriptionHtml;
    const normalizedRaw = rawDescription === null
      ? null
      : rawDescription.replace(/\r\n?/gu, '\n');
    const normalizedExpected = input.expectedDescriptionHtml === null
      ? null
      : input.expectedDescriptionHtml.replace(/\r\n?/gu, '\n');
    if (normalizedRaw !== normalizedExpected) {
      return outcome(workspace, 'unverified');
    }
    return outcome(workspace, 'observed');
  }
  if (row.ebay.unpublishedArtifactCount > 0 || row.ebay.offerCount > 0) {
    return outcome(workspace, 'artifact');
  }
  if (row.lifecycleStatus === 'not_listed'
    && row.ebay.listingId === null
    && row.ebay.offerId === null
    && row.ebay.activeMatchCount === 0
    && row.ebay.inventoryItemCount === 0) {
    return outcome(workspace, 'absent');
  }
  return outcome(workspace, 'unverified');
}

export function classifyEndOutcome(input: {
  workspace: ListingWorkspaceDto;
  sku: string;
  listingId: string;
}): LifecycleOutcome {
  const { workspace } = input;
  if (!captureBound(workspace, input.sku)) return outcome(workspace, 'unverified');
  const row = workspace.catalog;
  if (row.lifecycleStatus === 'unknown') return outcome(workspace, 'unverified');
  if (row.lifecycleStatus === 'active') {
    // Still active with the exact target listing: the end effect is not yet
    // visible. Active with a different listing is an ambiguous capture.
    return row.ebay.listingId === input.listingId
      ? outcome(workspace, 'absent')
      : outcome(workspace, 'unverified');
  }
  // The listing is no longer active on the fresh capture.
  return outcome(workspace, 'observed');
}
