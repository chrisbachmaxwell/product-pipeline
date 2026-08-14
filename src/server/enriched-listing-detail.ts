import { parseStringPromise } from 'xml2js';

export const EBAY_LISTING_DETAIL_SELLER_ID = 'usedcameragear';
export const EBAY_LISTING_DETAIL_MARKETPLACE_ID = 'EBAY_US';

const EBAY_TRADING_URL = 'https://api.ebay.com/ws/api.dll';
const EBAY_INVENTORY_ORIGIN = 'https://api.ebay.com';
const EBAY_TRADING_COMPATIBILITY_LEVEL = '1349';
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
// Preserve eBay's accepted description range while keeping a separate decoded-body safety bound.
const MAX_DESCRIPTION_CHARACTERS = 500_000;
const MAX_DESCRIPTION_UTF8_BYTES = 2_000_000;
const EBAY_IMAGE_HOSTS = new Set([
  'i.ebayimg.com',
  'thumbs.ebaystatic.com',
  'secureir.ebaystatic.com',
  'i.ebaystatic.com',
  'cdn.shopify.com',
]);

export const ENRICHED_LISTING_DETAIL_FAILURE_CODES = Object.freeze([
  'INVALID_REQUEST',
  'REMOTE_READ_FAILED',
  'RESPONSE_TOO_LARGE',
  'INVALID_RESPONSE',
  'SELLER_MISMATCH',
  'LISTING_MISMATCH',
  'SKU_MISMATCH',
  'OFFER_MISMATCH',
] as const);

export type EnrichedListingDetailFailureCode =
  (typeof ENRICHED_LISTING_DETAIL_FAILURE_CODES)[number];

export class EnrichedListingDetailError extends Error {
  readonly code: EnrichedListingDetailFailureCode;

  constructor(code: EnrichedListingDetailFailureCode) {
    super('Enriched eBay listing detail is unavailable');
    this.name = 'EnrichedListingDetailError';
    this.code = code;
  }
}

export type EbayListingManagementBinding =
  | Readonly<{
    model: 'legacy_trading';
    offerId?: never;
  }>
  | Readonly<{
    model: 'inventory_offer';
    offerId: string;
  }>;

type EnrichedListingDetailRequestBase = Readonly<{
  accessToken: string;
  sellerId: string;
  marketplaceId: string;
  sku: string;
  listingId: string;
  management: EbayListingManagementBinding;
}>;

export type EnrichedListingDetailRequest = EnrichedListingDetailRequestBase & (
  | Readonly<{
    mappingState: 'mapped';
    shopifyProductId: string;
    shopifyVariantId: string;
  }>
  | Readonly<{
    mappingState: 'ebay_only_unmapped';
    shopifyProductId: null;
    shopifyVariantId: null;
  }>
);

export type ListingMoney = Readonly<{
  value: string;
  currency: string;
}>;

export type ListingCategory = Readonly<{
  id: string;
  name: string | null;
}>;

export type ListingConditionDescriptor = Readonly<{
  name: string;
  values: readonly string[];
  additionalInfo: string | null;
}>;

export type ListingIdentifiers = Readonly<{
  brand: string | null;
  mpn: string | null;
  upc: readonly string[];
  ean: readonly string[];
  isbn: readonly string[];
  epid: string | null;
}>;

export type ListingContent = Readonly<{
  title: string | null;
  descriptionHtml: string | null;
  imageUrls: readonly string[];
}>;

export type ListingCondition = Readonly<{
  id: string | null;
  name: string | null;
  description: string | null;
  descriptors: readonly ListingConditionDescriptor[];
}>;

export type ListingActualDetail = Readonly<{
  lifecycle: Readonly<{
    status: string;
    active: boolean;
    format: string | null;
    duration: string | null;
    startAtUtc: string | null;
    endAtUtc: string | null;
  }>;
  content: ListingContent;
  category: Readonly<{
    primary: ListingCategory;
    secondary: ListingCategory | null;
    storeCategories: readonly ListingCategory[];
  }>;
  condition: ListingCondition;
  aspects: Readonly<Record<string, readonly string[]>>;
  identifiers: ListingIdentifiers;
  commerce: Readonly<{
    price: ListingMoney | null;
    totalQuantity: number | null;
    soldQuantity: number | null;
    availableQuantity: number | null;
    availableQuantityBasis: 'reported' | 'total_minus_sold' | 'unavailable';
    bestOfferEnabled: boolean | null;
  }>;
  policies: Readonly<{
    fulfillmentPolicyId: string | null;
    paymentPolicyId: string | null;
    returnPolicyId: string | null;
    paymentMethods: readonly string[];
    shippingType: string | null;
    domesticServices: readonly string[];
    internationalServices: readonly string[];
    returnsAccepted: boolean | null;
    returnPeriod: string | null;
    returnShippingCostPayer: string | null;
  }>;
  location: Readonly<{
    publicLocation: string | null;
    countryCode: string | null;
  }>;
}>;

export type InventoryItemControl = Readonly<{
  sku: string;
  content: ListingContent;
  condition: ListingCondition;
  aspects: Readonly<Record<string, readonly string[]>>;
  identifiers: ListingIdentifiers;
  shipToLocationQuantity: number | null;
}>;

export type InventoryOfferControl = Readonly<{
  offerId: string;
  sku: string;
  marketplaceId: string;
  status: string;
  listingStatus: string;
  listingOnHold: boolean | null;
  soldQuantity: number | null;
  format: string | null;
  duration: string | null;
  descriptionHtml: string | null;
  primaryCategoryId: string;
  secondaryCategoryId: string | null;
  storeCategoryNames: readonly string[];
  price: ListingMoney | null;
  availableQuantity: number | null;
  quantityLimitPerBuyer: number | null;
  bestOfferEnabled: boolean | null;
  autoAcceptPrice: ListingMoney | null;
  autoDeclinePrice: ListingMoney | null;
  fulfillmentPolicyId: string | null;
  paymentPolicyId: string | null;
  returnPolicyId: string | null;
  merchantLocationKey: string | null;
  includeCatalogProductDetails: boolean | null;
}>;

export type EnrichedListingDetail = Readonly<{
  schemaVersion: 1;
  evidence: Readonly<{
    source: 'ebay-trading-get-item' | 'ebay-trading-get-item+ebay-inventory-detail';
    observedAtUtc: string;
    complete: true;
    remoteReadPerformed: true;
    externalWritesPerformed: 0;
    requestCount: 2 | 4;
  }>;
  identity: Readonly<{
    sellerId: typeof EBAY_LISTING_DETAIL_SELLER_ID;
    marketplaceId: typeof EBAY_LISTING_DETAIL_MARKETPLACE_ID;
    mappingState: 'mapped' | 'ebay_only_unmapped';
    shopifyProductId: string | null;
    shopifyVariantId: string | null;
    sku: string;
    listingId: string;
    publicListingUrl: string | null;
    offerId: string | null;
  }>;
  actual: ListingActualDetail;
  management: Readonly<{
    model: 'legacy_trading' | 'inventory_offer';
    controlApi: 'trading' | 'inventory';
    joinKey: 'exact_raw_sku';
    exactBindings: Readonly<{
      seller: true;
      listing: true;
      sku: true;
      inventoryItem: boolean;
      offer: boolean;
      offerToListing: boolean;
    }>;
    lifecycleAligned: boolean;
    inventoryItem: InventoryItemControl | null;
    offer: InventoryOfferControl | null;
  }>;
}>;

type FetchLike = typeof fetch;
type UnknownRecord = Record<string, unknown>;

type ValidatedRequest = Readonly<{
  accessToken: string;
  mappingState: 'mapped' | 'ebay_only_unmapped';
  shopifyProductId: string | null;
  shopifyVariantId: string | null;
  sku: string;
  listingId: string;
  management: EbayListingManagementBinding;
}>;

type TradingSelection = Readonly<{
  actual: ListingActualDetail;
  publicListingUrl: string | null;
}>;

function fail(code: EnrichedListingDetailFailureCode): never {
  throw new EnrichedListingDetailError(code);
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown): UnknownRecord {
  return isRecord(value) ? value : fail('INVALID_RESPONSE');
}

function array(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function presentString(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) {
    return fail('INVALID_RESPONSE');
  }
  return value;
}

function optionalString(value: unknown, maximum: number): string | null {
  return value === undefined || value === null || value === ''
    ? null
    : presentString(value, maximum);
}

function optionalDescription(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string'
    || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)
    || Buffer.byteLength(value, 'utf8') > MAX_DESCRIPTION_UTF8_BYTES) {
    return fail('INVALID_RESPONSE');
  }
  let characters = 0;
  for (const _character of value) {
    characters += 1;
    if (characters > MAX_DESCRIPTION_CHARACTERS) return fail('INVALID_RESPONSE');
  }
  return value;
}

function identifierString(value: unknown, maximum = 128): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return presentString(value, maximum);
}

function integer(value: unknown, minimum = 0, maximum = 2_147_483_647): number {
  const parsed = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed)
    || parsed < minimum || parsed > maximum) return fail('INVALID_RESPONSE');
  return parsed;
}

function optionalInteger(value: unknown, minimum = 0): number | null {
  return value === undefined || value === null || value === '' ? null : integer(value, minimum);
}

function optionalBoolean(value: unknown): boolean | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 'True') return true;
  if (value === 'false' || value === 'False') return false;
  return fail('INVALID_RESPONSE');
}

function boundedStringArray(value: unknown, maximumEntries = 24, maximumLength = 256): string[] {
  const values = array(value);
  if (values.length > maximumEntries) return fail('INVALID_RESPONSE');
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of values) {
    const text = presentString(candidate, maximumLength);
    if (!seen.has(text)) {
      seen.add(text);
      result.push(text);
    }
  }
  return result;
}

function validateSku(value: unknown, code: EnrichedListingDetailFailureCode): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128
    || value.trim().length === 0 || /[\u0000-\u001F\u007F]/u.test(value)) return fail(code);
  return value;
}

function validateListingId(value: unknown, code: EnrichedListingDetailFailureCode): string {
  return typeof value === 'string' && /^\d{1,32}$/u.test(value) ? value : fail(code);
}

function validateOfferId(value: unknown, code: EnrichedListingDetailFailureCode): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128
    || /[\s/?#\u0000-\u001F\u007F]/u.test(value)) return fail(code);
  return value;
}

function validateShopifyGid(value: unknown, kind: 'Product' | 'ProductVariant'): string {
  if (typeof value !== 'string'
    || !new RegExp(`^gid://shopify/${kind}/[1-9]\\d{0,30}$`, 'u').test(value)) {
    return fail('INVALID_REQUEST');
  }
  return value;
}

function validateRequest(input: EnrichedListingDetailRequest): ValidatedRequest {
  if (!isRecord(input) || input.sellerId !== EBAY_LISTING_DETAIL_SELLER_ID
    || input.marketplaceId !== EBAY_LISTING_DETAIL_MARKETPLACE_ID) {
    return fail('INVALID_REQUEST');
  }
  const accessToken = presentString(input.accessToken, 4096);
  const sku = validateSku(input.sku, 'INVALID_REQUEST');
  const listingId = validateListingId(input.listingId, 'INVALID_REQUEST');
  if (input.mappingState !== 'mapped' && input.mappingState !== 'ebay_only_unmapped') {
    return fail('INVALID_REQUEST');
  }
  const shopifyProductId = input.mappingState === 'mapped'
    ? validateShopifyGid(input.shopifyProductId, 'Product')
    : input.shopifyProductId === null ? null : fail('INVALID_REQUEST');
  const shopifyVariantId = input.mappingState === 'mapped'
    ? validateShopifyGid(input.shopifyVariantId, 'ProductVariant')
    : input.shopifyVariantId === null ? null : fail('INVALID_REQUEST');
  if (!isRecord(input.management)
    || (input.management.model !== 'legacy_trading'
      && input.management.model !== 'inventory_offer')) return fail('INVALID_REQUEST');
  const management: EbayListingManagementBinding = input.management.model === 'legacy_trading'
    ? Object.freeze({ model: 'legacy_trading' as const })
    : Object.freeze({
      model: 'inventory_offer' as const,
      offerId: validateOfferId(input.management.offerId, 'INVALID_REQUEST'),
    });
  return Object.freeze({
    accessToken,
    mappingState: input.mappingState,
    shopifyProductId,
    shopifyVariantId,
    sku,
    listingId,
    management,
  });
}

function money(value: unknown): ListingMoney | null {
  if (value === undefined || value === null || value === '') return null;
  const objectValue = isRecord(value) ? value : null;
  const rawAmount = objectValue ? (objectValue.value ?? objectValue._) : value;
  const rawCurrency = objectValue
    ? (objectValue.currency ?? (isRecord(objectValue.$) ? objectValue.$.currencyID : undefined))
    : undefined;
  const amount = presentString(rawAmount, 64);
  const currency = presentString(rawCurrency, 16);
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d{1,8})?$/u.test(amount)
    || !/^[A-Z]{3}$/u.test(currency)) return fail('INVALID_RESPONSE');
  return Object.freeze({ value: amount, currency });
}

function isoTime(value: unknown): string | null {
  const text = optionalString(value, 64);
  if (text === null) return null;
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return fail('INVALID_RESPONSE');
  return new Date(timestamp).toISOString();
}

function safeHttpsUrl(
  value: unknown,
  purpose: 'public_listing' | 'ebay_image',
  expectedListingId?: string,
): string | null {
  const text = optionalString(value, 2048);
  if (text === null) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail('INVALID_RESPONSE');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') {
    return fail('INVALID_RESPONSE');
  }
  if (purpose === 'public_listing') {
    if (expectedListingId === undefined
      || (url.hostname !== 'www.ebay.com' && url.hostname !== 'ebay.com')
      || !new RegExp(`^/itm/(?:[^/?]+/)?${expectedListingId}/?$`, 'u').test(url.pathname)) {
      return fail('LISTING_MISMATCH');
    }
  } else if (!EBAY_IMAGE_HOSTS.has(url.hostname) || url.searchParams.has('token')
    || url.searchParams.has('access_token') || url.searchParams.has('signature')) {
    return fail('INVALID_RESPONSE');
  }
  return url.toString();
}

function imageUrls(value: unknown): string[] {
  const candidates = array(value);
  if (candidates.length > 24) return fail('INVALID_RESPONSE');
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const url = safeHttpsUrl(candidate, 'ebay_image');
    if (url !== null && !seen.has(url)) {
      seen.add(url);
      result.push(url);
    }
  }
  return result;
}

async function readBoundedResponse(response: Response): Promise<string> {
  const header = response.headers.get('content-length');
  if (header !== null) {
    if (!/^\d+$/u.test(header)) return fail('INVALID_RESPONSE');
    if (Number(header) > MAX_RESPONSE_BYTES) return fail('RESPONSE_TOO_LARGE');
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return fail('RESPONSE_TOO_LARGE');
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof EnrichedListingDetailError) throw error;
    return fail('REMOTE_READ_FAILED');
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

async function boundedFetchText(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      ...init,
      redirect: 'error',
      signal: controller.signal,
    });
    const body = await readBoundedResponse(response);
    if (!response.ok) return fail('REMOTE_READ_FAILED');
    return body;
  } catch (error) {
    if (error instanceof EnrichedListingDetailError) throw error;
    return fail('REMOTE_READ_FAILED');
  } finally {
    clearTimeout(timeout);
  }
}

async function boundedFetchJson(
  fetchImpl: FetchLike,
  path: string,
  accessToken: string,
): Promise<UnknownRecord> {
  if (!path.startsWith('/sell/inventory/v1/') || path.includes('..')) {
    return fail('INVALID_REQUEST');
  }
  const text = await boundedFetchText(fetchImpl, `${EBAY_INVENTORY_ORIGIN}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Accept-Language': 'en-US',
    },
  });
  try {
    return record(JSON.parse(text));
  } catch (error) {
    if (error instanceof EnrichedListingDetailError) throw error;
    return fail('INVALID_RESPONSE');
  }
}

async function tradingRead(
  fetchImpl: FetchLike,
  accessToken: string,
  callName: 'GetUser' | 'GetItem',
  body: string,
): Promise<UnknownRecord> {
  const text = await boundedFetchText(fetchImpl, EBAY_TRADING_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml',
      'X-EBAY-API-COMPATIBILITY-LEVEL': EBAY_TRADING_COMPATIBILITY_LEVEL,
      'X-EBAY-API-CALL-NAME': callName,
      'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-IAF-TOKEN': accessToken,
    },
    body,
  });
  if (/<!DOCTYPE|<!ENTITY/iu.test(text)) return fail('INVALID_RESPONSE');
  let parsed: unknown;
  try {
    parsed = await parseStringPromise(text, {
      explicitArray: false,
      explicitRoot: true,
      trim: true,
      normalizeTags: false,
    });
  } catch {
    return fail('INVALID_RESPONSE');
  }
  const result = record(record(parsed)[`${callName}Response`]);
  if (result.Ack !== 'Success' || result.Errors !== undefined) return fail('REMOTE_READ_FAILED');
  return result;
}

function optionalRecord(value: unknown): UnknownRecord | null {
  return value === undefined || value === null ? null : record(value);
}

function category(value: unknown, required: boolean): ListingCategory | null {
  const source = optionalRecord(value);
  if (source === null) return required ? fail('INVALID_RESPONSE') : null;
  const id = identifierString(source.CategoryID, 32);
  if (id === null || !/^\d+$/u.test(id)) return fail('INVALID_RESPONSE');
  return Object.freeze({ id, name: optionalString(source.CategoryName, 256) });
}

function categoryFromId(value: unknown, required: boolean): ListingCategory | null {
  const id = identifierString(value, 32);
  if (id === null) return required ? fail('INVALID_RESPONSE') : null;
  if (!/^\d+$/u.test(id)) return fail('INVALID_RESPONSE');
  return Object.freeze({ id, name: null });
}

function ensureAspectName(name: string, seenCanonical: Map<string, string>): void {
  if (name === '__proto__' || name === 'prototype' || name === 'constructor') {
    return fail('INVALID_RESPONSE');
  }
  const canonical = name.normalize('NFKC').toLocaleLowerCase('en-US').trim();
  if (canonical.length === 0) return fail('INVALID_RESPONSE');
  const existing = seenCanonical.get(canonical);
  if (existing !== undefined && existing !== name) return fail('INVALID_RESPONSE');
  seenCanonical.set(canonical, name);
}

function mergeAspectValues(
  target: Record<string, string[]>,
  name: string,
  values: readonly string[],
): void {
  const existing = target[name] ?? [];
  for (const value of values) {
    if (!existing.includes(value)) existing.push(value);
  }
  if (existing.length > 20) return fail('INVALID_RESPONSE');
  target[name] = existing;
}

function tradingAspects(...sources: unknown[]): Readonly<Record<string, readonly string[]>> {
  const result: Record<string, string[]> = {};
  const names = new Map<string, string>();
  let count = 0;
  for (const source of sources) {
    const container = optionalRecord(source);
    if (container === null) continue;
    for (const raw of array(container.NameValueList)) {
      count += 1;
      if (count > 100) return fail('INVALID_RESPONSE');
      const row = record(raw);
      const name = presentString(row.Name, 128);
      ensureAspectName(name, names);
      const values = boundedStringArray(row.Value, 20, 256);
      if (values.length === 0) return fail('INVALID_RESPONSE');
      mergeAspectValues(result, name, values);
    }
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(result).map(([name, values]) => [name, Object.freeze(values)]),
  ));
}

function inventoryAspects(value: unknown): Readonly<Record<string, readonly string[]>> {
  if (value === undefined || value === null) return Object.freeze({});
  const source = record(value);
  const entries = Object.entries(source);
  if (entries.length > 100) return fail('INVALID_RESPONSE');
  const result: Record<string, readonly string[]> = {};
  const names = new Map<string, string>();
  for (const [name, rawValues] of entries) {
    const safeName = presentString(name, 128);
    ensureAspectName(safeName, names);
    const values = boundedStringArray(rawValues, 20, 256);
    if (values.length === 0) return fail('INVALID_RESPONSE');
    result[safeName] = Object.freeze(values);
  }
  return Object.freeze(result);
}

function conditionDescriptors(value: unknown): readonly ListingConditionDescriptor[] {
  if (value === undefined || value === null) return Object.freeze([]);
  const container = isRecord(value)
    ? (value.ConditionDescriptor ?? value.conditionDescriptors ?? value)
    : value;
  const rows = array(container);
  if (rows.length > 20) return fail('INVALID_RESPONSE');
  return Object.freeze(rows.map((raw) => {
    const descriptor = record(raw);
    const name = presentString(descriptor.Name ?? descriptor.name, 128);
    const rawValues = descriptor.Value ?? descriptor.values ?? descriptor.value;
    const values = boundedStringArray(rawValues, 20, 256);
    if (values.length === 0) return fail('INVALID_RESPONSE');
    return Object.freeze({
      name,
      values: Object.freeze(values),
      additionalInfo: optionalString(
        descriptor.AdditionalInfo ?? descriptor.additionalInfo,
        1_024,
      ),
    });
  }));
}

function aspectIdentifier(
  aspects: Readonly<Record<string, readonly string[]>>,
  key: string,
): string | null {
  const values = aspects[key];
  return values?.length === 1 ? values[0]! : null;
}

function identifiersFromTrading(
  productListingDetails: unknown,
  aspects: Readonly<Record<string, readonly string[]>>,
): ListingIdentifiers {
  const details = optionalRecord(productListingDetails) ?? {};
  const brandMpn = optionalRecord(details.BrandMPN) ?? {};
  return Object.freeze({
    brand: identifierString(brandMpn.Brand, 256) ?? aspectIdentifier(aspects, 'Brand'),
    mpn: identifierString(brandMpn.MPN, 256) ?? aspectIdentifier(aspects, 'MPN'),
    upc: Object.freeze(boundedStringArray(details.UPC, 20, 128)),
    ean: Object.freeze(boundedStringArray(details.EAN, 20, 128)),
    isbn: Object.freeze(boundedStringArray(details.ISBN, 20, 128)),
    epid: identifierString(details.ProductReferenceID ?? details.ePID, 128),
  });
}

function identifiersFromInventory(product: UnknownRecord): ListingIdentifiers {
  return Object.freeze({
    brand: identifierString(product.brand, 256),
    mpn: identifierString(product.mpn, 256),
    upc: Object.freeze(boundedStringArray(product.upc, 20, 128)),
    ean: Object.freeze(boundedStringArray(product.ean, 20, 128)),
    isbn: Object.freeze(boundedStringArray(product.isbn, 20, 128)),
    epid: identifierString(product.epid ?? product.ePID, 128),
  });
}

function selectTradingSku(item: UnknownRecord, expectedSku: string): UnknownRecord | null {
  const exact: Array<UnknownRecord | null> = [];
  const itemSku = item.SKU === undefined || item.SKU === null || item.SKU === ''
    ? null
    : validateSku(item.SKU, 'INVALID_RESPONSE');
  if (itemSku === expectedSku) exact.push(null);

  const variations = optionalRecord(item.Variations);
  const rows = array(variations?.Variation);
  if (rows.length > 250) return fail('INVALID_RESPONSE');
  for (const raw of rows) {
    const variation = record(raw);
    const sku = validateSku(variation.SKU, 'INVALID_RESPONSE');
    if (sku === expectedSku) exact.push(variation);
  }
  if (exact.length !== 1) return fail('SKU_MISMATCH');
  return exact[0]!;
}

function quantityProjection(
  totalValue: unknown,
  soldValue: unknown,
  availableValue: unknown,
): Pick<ListingActualDetail['commerce'],
  'totalQuantity' | 'soldQuantity' | 'availableQuantity' | 'availableQuantityBasis'> {
  const totalQuantity = optionalInteger(totalValue);
  const soldQuantity = optionalInteger(soldValue);
  const reportedAvailable = optionalInteger(availableValue);
  if (totalQuantity !== null && soldQuantity !== null && soldQuantity > totalQuantity) {
    return fail('INVALID_RESPONSE');
  }
  if (reportedAvailable !== null) {
    return {
      totalQuantity,
      soldQuantity,
      availableQuantity: reportedAvailable,
      availableQuantityBasis: 'reported',
    };
  }
  if (totalQuantity !== null && soldQuantity !== null) {
    return {
      totalQuantity,
      soldQuantity,
      availableQuantity: totalQuantity - soldQuantity,
      availableQuantityBasis: 'total_minus_sold',
    };
  }
  return {
    totalQuantity,
    soldQuantity,
    availableQuantity: null,
    availableQuantityBasis: 'unavailable',
  };
}

function policyId(value: unknown): string | null {
  const id = identifierString(value, 64);
  return id !== null && /^\d+$/u.test(id) ? id : id === null ? null : fail('INVALID_RESPONSE');
}

function returnsAccepted(value: unknown): boolean | null {
  const option = optionalString(value, 64);
  if (option === null) return null;
  if (option === 'ReturnsAccepted') return true;
  if (option === 'ReturnsNotAccepted') return false;
  return fail('INVALID_RESPONSE');
}

function storeCategories(storefrontValue: unknown): readonly ListingCategory[] {
  const storefront = optionalRecord(storefrontValue);
  if (storefront === null) return Object.freeze([]);
  const candidates = [
    [storefront.StoreCategoryID, storefront.StoreCategoryName],
    [storefront.StoreCategory2ID, storefront.StoreCategory2Name],
  ] as const;
  const result: ListingCategory[] = [];
  for (const [rawId, rawName] of candidates) {
    const id = identifierString(rawId, 32);
    if (id === null || id === '0') continue;
    if (!/^\d+$/u.test(id)) return fail('INVALID_RESPONSE');
    result.push(Object.freeze({ id, name: optionalString(rawName, 256) }));
  }
  return Object.freeze(result);
}

function tradingPolicyProjection(item: UnknownRecord): ListingActualDetail['policies'] {
  const sellerProfiles = optionalRecord(item.SellerProfiles) ?? {};
  const shippingProfile = optionalRecord(sellerProfiles.SellerShippingProfile) ?? {};
  const paymentProfile = optionalRecord(sellerProfiles.SellerPaymentProfile) ?? {};
  const returnProfile = optionalRecord(sellerProfiles.SellerReturnProfile) ?? {};
  const shipping = optionalRecord(item.ShippingDetails) ?? {};
  const returnPolicy = optionalRecord(item.ReturnPolicy) ?? {};
  const domestic = array(shipping.ShippingServiceOptions);
  const international = array(shipping.InternationalShippingServiceOption);
  if (domestic.length > 20 || international.length > 20) return fail('INVALID_RESPONSE');
  return Object.freeze({
    fulfillmentPolicyId: policyId(shippingProfile.ShippingProfileID),
    paymentPolicyId: policyId(paymentProfile.PaymentProfileID),
    returnPolicyId: policyId(returnProfile.ReturnProfileID),
    paymentMethods: Object.freeze(boundedStringArray(item.PaymentMethods, 20, 128)),
    shippingType: optionalString(shipping.ShippingType, 64),
    domesticServices: Object.freeze(domestic.map((entry) =>
      presentString(record(entry).ShippingService, 128))),
    internationalServices: Object.freeze(international.map((entry) =>
      presentString(record(entry).ShippingService, 128))),
    returnsAccepted: returnsAccepted(returnPolicy.ReturnsAcceptedOption),
    returnPeriod: optionalString(
      returnPolicy.ReturnsWithinOption ?? returnPolicy.ReturnsWithin,
      64,
    ),
    returnShippingCostPayer: optionalString(
      returnPolicy.ShippingCostPaidByOption ?? returnPolicy.ShippingCostPaidBy,
      64,
    ),
  });
}

export function parseTradingItemDetail(
  response: UnknownRecord,
  expected: Readonly<{ sellerId: string; listingId: string; sku: string }>,
): TradingSelection {
  const item = record(response.Item);
  const listingId = validateListingId(item.ItemID, 'INVALID_RESPONSE');
  if (listingId !== expected.listingId) return fail('LISTING_MISMATCH');
  const seller = record(item.Seller);
  const sellerId = presentString(seller.UserID, 128);
  if (sellerId.toLocaleLowerCase('en-US') !== expected.sellerId) {
    return fail('SELLER_MISMATCH');
  }
  const variation = selectTradingSku(item, expected.sku);
  const sellingStatus = optionalRecord(variation?.SellingStatus)
    ?? record(item.SellingStatus);
  const listingStatus = presentString(sellingStatus.ListingStatus, 64).toUpperCase();
  const listingDetails = optionalRecord(item.ListingDetails) ?? {};
  const itemSpecifics = optionalRecord(item.ItemSpecifics);
  const variationSpecifics = variation === null ? null : optionalRecord(variation.VariationSpecifics);
  const aspects = tradingAspects(itemSpecifics, variationSpecifics);
  const quantity = quantityProjection(
    variation?.Quantity ?? item.Quantity,
    sellingStatus.QuantitySold,
    variation?.QuantityAvailable ?? item.QuantityAvailable,
  );
  const pictureDetails = optionalRecord(item.PictureDetails) ?? {};
  const conditionContainer = optionalRecord(item.ConditionDescriptors);
  const primaryCategory = category(item.PrimaryCategory, true)!;
  const publicListingUrl = safeHttpsUrl(
    listingDetails.ViewItemURLForNaturalSearch ?? listingDetails.ViewItemURL,
    'public_listing',
    expected.listingId,
  );
  const actual: ListingActualDetail = Object.freeze({
    lifecycle: Object.freeze({
      status: listingStatus,
      active: listingStatus === 'ACTIVE',
      format: optionalString(item.ListingType, 64),
      duration: optionalString(item.ListingDuration, 64),
      startAtUtc: isoTime(listingDetails.StartTime),
      endAtUtc: isoTime(listingDetails.EndTime),
    }),
    content: Object.freeze({
      title: optionalString(item.Title, 512),
      descriptionHtml: optionalDescription(item.Description),
      imageUrls: Object.freeze(imageUrls(pictureDetails.PictureURL)),
    }),
    category: Object.freeze({
      primary: primaryCategory,
      secondary: category(item.SecondaryCategory, false),
      storeCategories: storeCategories(item.Storefront),
    }),
    condition: Object.freeze({
      id: identifierString(item.ConditionID, 64),
      name: optionalString(item.ConditionDisplayName, 256),
      description: optionalString(item.ConditionDescription, 5_000),
      descriptors: conditionDescriptors(conditionContainer),
    }),
    aspects,
    identifiers: identifiersFromTrading(item.ProductListingDetails, aspects),
    commerce: Object.freeze({
      price: money(variation?.StartPrice ?? sellingStatus.CurrentPrice),
      ...quantity,
      bestOfferEnabled: optionalBoolean(optionalRecord(item.BestOfferDetails)?.BestOfferEnabled),
    }),
    policies: tradingPolicyProjection(item),
    location: Object.freeze({
      publicLocation: optionalString(item.Location, 256),
      countryCode: optionalString(item.Country, 8),
    }),
  });
  return Object.freeze({ actual, publicListingUrl });
}

export function parseInventoryItemControl(
  body: UnknownRecord,
  expectedSku: string,
): InventoryItemControl {
  if (body.sku !== undefined && validateSku(body.sku, 'INVALID_RESPONSE') !== expectedSku) {
    return fail('SKU_MISMATCH');
  }
  const product = optionalRecord(body.product) ?? {};
  const availability = optionalRecord(body.availability) ?? {};
  const shipToLocation = optionalRecord(availability.shipToLocationAvailability) ?? {};
  return Object.freeze({
    sku: expectedSku,
    content: Object.freeze({
      title: optionalString(product.title, 512),
      descriptionHtml: optionalDescription(product.description),
      imageUrls: Object.freeze(imageUrls(product.imageUrls)),
    }),
    condition: Object.freeze({
      id: null,
      name: optionalString(body.condition, 128),
      description: optionalString(body.conditionDescription, 5_000),
      descriptors: conditionDescriptors(body.conditionDescriptors),
    }),
    aspects: inventoryAspects(product.aspects),
    identifiers: identifiersFromInventory(product),
    shipToLocationQuantity: optionalInteger(shipToLocation.quantity),
  });
}

export function parseInventoryOfferControl(
  body: UnknownRecord,
  expected: Readonly<{
    offerId: string;
    sku: string;
    listingId: string;
    marketplaceId: string;
  }>,
): InventoryOfferControl {
  const offerId = validateOfferId(body.offerId, 'INVALID_RESPONSE');
  if (offerId !== expected.offerId) return fail('OFFER_MISMATCH');
  const sku = validateSku(body.sku, 'INVALID_RESPONSE');
  if (sku !== expected.sku) return fail('SKU_MISMATCH');
  const marketplaceId = presentString(body.marketplaceId, 64);
  if (marketplaceId !== expected.marketplaceId) return fail('OFFER_MISMATCH');
  const listing = record(body.listing);
  const listingId = validateListingId(listing.listingId, 'INVALID_RESPONSE');
  if (listingId !== expected.listingId) return fail('LISTING_MISMATCH');
  const status = presentString(body.status, 64).toUpperCase();
  const listingStatus = presentString(listing.listingStatus, 64).toUpperCase();
  const policies = optionalRecord(body.listingPolicies) ?? {};
  const bestOffer = optionalRecord(policies.bestOfferTerms) ?? {};
  const pricing = optionalRecord(body.pricingSummary) ?? {};
  return Object.freeze({
    offerId,
    sku,
    marketplaceId,
    status,
    listingStatus,
    listingOnHold: optionalBoolean(listing.listingOnHold),
    soldQuantity: optionalInteger(listing.soldQuantity),
    format: optionalString(body.format, 64),
    duration: optionalString(body.listingDuration, 64),
    descriptionHtml: optionalDescription(body.listingDescription),
    primaryCategoryId: categoryFromId(body.categoryId, true)!.id,
    secondaryCategoryId: categoryFromId(body.secondaryCategoryId, false)?.id ?? null,
    storeCategoryNames: Object.freeze(boundedStringArray(body.storeCategoryNames, 20, 256)),
    price: money(pricing.price),
    availableQuantity: optionalInteger(body.availableQuantity),
    quantityLimitPerBuyer: optionalInteger(body.quantityLimitPerBuyer, 1),
    bestOfferEnabled: optionalBoolean(bestOffer.bestOfferEnabled),
    autoAcceptPrice: money(bestOffer.autoAcceptPrice),
    autoDeclinePrice: money(bestOffer.autoDeclinePrice),
    fulfillmentPolicyId: policyId(policies.fulfillmentPolicyId),
    paymentPolicyId: policyId(policies.paymentPolicyId),
    returnPolicyId: policyId(policies.returnPolicyId),
    merchantLocationKey: optionalString(body.merchantLocationKey, 256),
    includeCatalogProductDetails: optionalBoolean(body.includeCatalogProductDetails),
  });
}

function getUserRequest(): string {
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<GetUserRequest xmlns="urn:ebay:apis:eBLBaseComponents"/>';
}

function getItemRequest(listingId: string): string {
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">'
    + '<DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>true</IncludeItemSpecifics>'
    + `<ItemID>${listingId}</ItemID></GetItemRequest>`;
}

function sellerFromGetUser(result: UnknownRecord): string {
  return presentString(record(result.User).UserID, 128).toLocaleLowerCase('en-US');
}

export function createEnrichedListingDetailReader(dependencies: Readonly<{
  fetchImpl?: FetchLike;
  now?: () => Date;
}> = {}) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const now = dependencies.now ?? (() => new Date());

  return async (input: EnrichedListingDetailRequest): Promise<EnrichedListingDetail> => {
    const request = validateRequest(input);
    const user = await tradingRead(
      fetchImpl,
      request.accessToken,
      'GetUser',
      getUserRequest(),
    );
    if (sellerFromGetUser(user) !== EBAY_LISTING_DETAIL_SELLER_ID) {
      return fail('SELLER_MISMATCH');
    }

    const itemPromise = tradingRead(
      fetchImpl,
      request.accessToken,
      'GetItem',
      getItemRequest(request.listingId),
    );

    let inventoryItem: InventoryItemControl | null = null;
    let offer: InventoryOfferControl | null = null;
    let itemResult: UnknownRecord;

    if (request.management.model === 'inventory_offer') {
      const [tradingItem, inventoryBody, offerBody] = await Promise.all([
        itemPromise,
        boundedFetchJson(
          fetchImpl,
          `/sell/inventory/v1/inventory_item/${encodeURIComponent(request.sku)}`,
          request.accessToken,
        ),
        boundedFetchJson(
          fetchImpl,
          `/sell/inventory/v1/offer/${encodeURIComponent(request.management.offerId)}`,
          request.accessToken,
        ),
      ]);
      itemResult = tradingItem;
      inventoryItem = parseInventoryItemControl(inventoryBody, request.sku);
      offer = parseInventoryOfferControl(offerBody, {
        offerId: request.management.offerId,
        sku: request.sku,
        listingId: request.listingId,
        marketplaceId: EBAY_LISTING_DETAIL_MARKETPLACE_ID,
      });
    } else {
      itemResult = await itemPromise;
    }

    const trading = parseTradingItemDetail(itemResult, {
      sellerId: EBAY_LISTING_DETAIL_SELLER_ID,
      listingId: request.listingId,
      sku: request.sku,
    });
    const offerActive = offer === null
      ? trading.actual.lifecycle.active
      : offer.status === 'PUBLISHED'
        && offer.listingStatus === 'ACTIVE'
        && offer.listingOnHold !== true;
    const observedAt = now();
    if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) {
      return fail('INVALID_RESPONSE');
    }

    return Object.freeze({
      schemaVersion: 1 as const,
      evidence: Object.freeze({
        source: request.management.model === 'inventory_offer'
          ? 'ebay-trading-get-item+ebay-inventory-detail' as const
          : 'ebay-trading-get-item' as const,
        observedAtUtc: observedAt.toISOString(),
        complete: true as const,
        remoteReadPerformed: true as const,
        externalWritesPerformed: 0 as const,
        requestCount: request.management.model === 'inventory_offer' ? 4 as const : 2 as const,
      }),
      identity: Object.freeze({
        sellerId: EBAY_LISTING_DETAIL_SELLER_ID,
        marketplaceId: EBAY_LISTING_DETAIL_MARKETPLACE_ID,
        mappingState: request.mappingState,
        shopifyProductId: request.shopifyProductId,
        shopifyVariantId: request.shopifyVariantId,
        sku: request.sku,
        listingId: request.listingId,
        publicListingUrl: trading.publicListingUrl,
        offerId: request.management.model === 'inventory_offer'
          ? request.management.offerId
          : null,
      }),
      actual: trading.actual,
      management: Object.freeze({
        model: request.management.model,
        controlApi: request.management.model === 'inventory_offer' ? 'inventory' as const : 'trading' as const,
        joinKey: 'exact_raw_sku' as const,
        exactBindings: Object.freeze({
          seller: true as const,
          listing: true as const,
          sku: true as const,
          inventoryItem: inventoryItem !== null,
          offer: offer !== null,
          offerToListing: offer !== null,
        }),
        lifecycleAligned: trading.actual.lifecycle.active === offerActive,
        inventoryItem,
        offer,
      }),
    });
  };
}

export const ENRICHED_LISTING_DETAIL_TESTING = Object.freeze({
  MAX_RESPONSE_BYTES,
  MAX_DESCRIPTION_CHARACTERS,
  MAX_DESCRIPTION_UTF8_BYTES,
  REQUEST_TIMEOUT_MS,
});
