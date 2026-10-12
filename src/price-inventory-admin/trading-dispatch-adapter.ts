/**
 * Bounded eBay Trading-API alignment adapter for the isolated
 * price/inventory operator CLI — the legacy-Trading-model half of the
 * price/inventory slice. Its `reviseInventoryStatus` performs one POST of
 * one `ReviseInventoryStatus` XML request to exactly one host, carrying
 * exactly ONE `InventoryStatus` element: the ItemID plus either a
 * `StartPrice` (a price alignment) or a `Quantity` (a quantity alignment),
 * never both. Only when eBay refuses a PRICE because of a Best Offer
 * threshold does it send one bounded `ReviseFixedPriceItem` (price plus the
 * named threshold deletions, L99). A
 * structural assertion on the serialized XML guarantees a price dispatch can
 * never contain a Quantity element and a quantity dispatch can never contain
 * a StartPrice element. Errors are redacted to fixed codes; no token, URL,
 * payload, or provider body is ever thrown or logged.
 *
 * This module is intentionally not imported by the server, webhooks,
 * schedulers, or any legacy sync path. Its POSTs are reachable only
 * from the dispatch ceremony in `program.ts`, which requires a reserved
 * migration-store job under a live one-action approval before calling it.
 */
import fs from 'node:fs';
import { parseStringPromise } from 'xml2js';

const EBAY_TRADING_URL = 'https://api.ebay.com/ws/api.dll';
const EBAY_TRADING_COMPATIBILITY_LEVEL = '1349';
const EBAY_TRADING_SITE_ID = '0';
const EBAY_TRADING_CALL_NAME = 'ReviseInventoryStatus';
const EBAY_TRADING_END_CALL_NAME = 'EndFixedPriceItem';
const EBAY_TRADING_RELIST_CALL_NAME = 'RelistFixedPriceItem';
const EBAY_TRADING_REVISE_FIXED_CALL_NAME = 'ReviseFixedPriceItem';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const EXACT_ITEM_ID = /^[0-9]{1,19}$/;
const PRICE_AMOUNT = /^[0-9]{1,10}(\.[0-9]{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;

export class TradingAlignDispatchError extends Error {
  constructor(readonly code:
    | 'TRADING_ALIGN_AUTHORITY_UNAVAILABLE'
    | 'TRADING_ALIGN_TARGET_INVALID'
    | 'TRADING_ALIGN_PAYLOAD_INVALID'
    | 'TRADING_ALIGN_PAYLOAD_TOO_LARGE'
    | 'TRADING_ALIGN_WRITE_FAILED'
    | 'TRADING_ALIGN_REJECTED') {
    super('Trading price/inventory alignment dispatch adapter failed');
    this.name = 'TradingAlignDispatchError';
  }
}

const deny = (code: ConstructorParameters<typeof TradingAlignDispatchError>[0]): never => {
  throw new TradingAlignDispatchError(code);
};

type FetchLike = typeof fetch;

export type TradingAlignInput =
  | Readonly<{
    listingId: string;
    field: 'price';
    price: Readonly<{ value: string; currency: string }>;
  }>
  | Readonly<{
    listingId: string;
    field: 'quantity';
    quantity: number;
  }>;

/**
 * Best Offer thresholds eBay requires to sit strictly below the Buy It Now
 * price. A price lowered to or under one of them is refused (incident #178,
 * error 23004 "Invalid AutoAccept price"), so the price fallback deletes
 * exactly the threshold(s) eBay named -- never anything else.
 */
export const BEST_OFFER_THRESHOLD_FIELDS = Object.freeze({
  autoAccept: 'Item.ListingDetails.BestOfferAutoAcceptPrice',
  autoDecline: 'Item.ListingDetails.MinimumBestOfferPrice',
} as const);
export type BestOfferThresholdField =
  typeof BEST_OFFER_THRESHOLD_FIELDS[keyof typeof BEST_OFFER_THRESHOLD_FIELDS];
const BEST_OFFER_THRESHOLD_FIELD_SET: ReadonlySet<string> =
  new Set(Object.values(BEST_OFFER_THRESHOLD_FIELDS));

/** What a revise did beyond the one ReviseInventoryStatus, if anything. */
export type TradingAlignResult = Readonly<{
  /** Thresholds the L99 price fallback deleted; empty when none ran. */
  clearedBestOfferThresholds: readonly BestOfferThresholdField[];
}>;

export type TradingAlignDispatchAdapter = Readonly<{
  /**
   * One ReviseInventoryStatus. For a PRICE alignment only, if eBay refuses
   * it because the new price is at or under the listing's Best Offer
   * auto-accept or auto-decline threshold, exactly one follow-up
   * ReviseFixedPriceItem sets the same price and deletes the named
   * threshold(s) (L99). The refused first call changed nothing, so the
   * listing receives at most one effective write either way.
   */
  reviseInventoryStatus: (input: TradingAlignInput) => Promise<TradingAlignResult | void>;
  /**
   * End one fixed-price listing because the item is no longer available.
   * This is the sell-out path for this seller account: eBay refuses an
   * available-quantity-0 revision when the account's out-of-stock option is
   * off, which is also why the Marketplace Connect incumbent must have ended
   * listings rather than zeroing them.
   */
  endFixedPriceItem: (input: Readonly<{ listingId: string }>) => Promise<void>;
  /**
   * Relist one previously ended fixed-price listing because stock returned,
   * overriding quantity and price to the current Shopify source values so the
   * revived listing matches the store the moment it reappears. eBay restores
   * everything else (title, photos, description, policies) from the ended
   * listing, refuses a relist of anything that is not this seller's ended
   * listing, and ages the option out ~90 days after ending. Returns the NEW
   * listing id.
   */
  relistFixedPriceItem: (input: Readonly<{
    listingId: string;
    quantity: number;
    price: Readonly<{ value: string; currency: string }>;
  }>) => Promise<string>;
}>;

/**
 * Serialize the one bounded ReviseInventoryStatus request: exactly one
 * InventoryStatus element with the exact ItemID plus exactly one aligned
 * element. Every serialized value is validated against a strict safe
 * grammar (numeric item id, decimal amount, ISO currency, safe integer), so
 * no XML escaping surface exists; the price/quantity cross-contamination
 * assertion runs on the final serialized document.
 */
export function buildReviseInventoryStatusXml(input: TradingAlignInput): string {
  if (!EXACT_ITEM_ID.test(input.listingId)) deny('TRADING_ALIGN_TARGET_INVALID');
  let alignedElement: string;
  if (input.field === 'price') {
    const { price } = input;
    if (!price || typeof price.value !== 'string' || !PRICE_AMOUNT.test(price.value)
      || Number(price.value) <= 0 || typeof price.currency !== 'string'
      || !CURRENCY.test(price.currency)) {
      deny('TRADING_ALIGN_PAYLOAD_INVALID');
    }
    alignedElement = `<StartPrice currencyID="${price.currency}">${price.value}</StartPrice>`;
  } else if (input.field === 'quantity') {
    if (!Number.isSafeInteger(input.quantity) || input.quantity < 0) {
      deny('TRADING_ALIGN_PAYLOAD_INVALID');
    }
    alignedElement = `<Quantity>${String(input.quantity)}</Quantity>`;
  } else {
    return deny('TRADING_ALIGN_PAYLOAD_INVALID');
  }

  const xml = '<?xml version="1.0" encoding="utf-8"?>'
    + '<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">'
    + `<InventoryStatus><ItemID>${input.listingId}</ItemID>${alignedElement}</InventoryStatus>`
    + '</ReviseInventoryStatusRequest>';

  // Structural assertions on the serialized document: exactly one
  // InventoryStatus element, and zero cross-field contamination.
  if ((xml.match(/<InventoryStatus>/g) ?? []).length !== 1
    || (xml.match(/<\/InventoryStatus>/g) ?? []).length !== 1) {
    deny('TRADING_ALIGN_PAYLOAD_INVALID');
  }
  if (input.field === 'price' && /<\/?Quantity\b/iu.test(xml)) {
    deny('TRADING_ALIGN_PAYLOAD_INVALID');
  }
  if (input.field === 'quantity' && /<\/?StartPrice\b/iu.test(xml)) {
    deny('TRADING_ALIGN_PAYLOAD_INVALID');
  }
  return xml;
}

/**
 * Serialize the one bounded EndFixedPriceItem request: exactly one exact
 * ItemID and the fixed NotAvailable reason -- the only reason that truthfully
 * describes a sell-out. Nothing else may appear: no price, no quantity, so a
 * defect can never turn an end into a revise or vice versa.
 */
export function buildEndFixedPriceItemXml(input: Readonly<{ listingId: string }>): string {
  if (!EXACT_ITEM_ID.test(input.listingId)) deny('TRADING_ALIGN_TARGET_INVALID');
  const xml = '<?xml version="1.0" encoding="utf-8"?>'
    + '<EndFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">'
    + `<ItemID>${input.listingId}</ItemID>`
    + '<EndingReason>NotAvailable</EndingReason>'
    + '</EndFixedPriceItemRequest>';
  if ((xml.match(/<ItemID>/g) ?? []).length !== 1
    || /<\/?StartPrice\b/iu.test(xml)
    || /<\/?Quantity\b/iu.test(xml)) {
    deny('TRADING_ALIGN_PAYLOAD_INVALID');
  }
  return xml;
}

/**
 * Serialize the one bounded RelistFixedPriceItem request: the exact ended
 * ItemID plus the two Shopify source values the revived listing must carry.
 * Same strict grammars as the revise serializer; anything else is refused.
 */
export function buildRelistFixedPriceItemXml(input: Readonly<{
  listingId: string;
  quantity: number;
  price: Readonly<{ value: string; currency: string }>;
}>): string {
  if (!EXACT_ITEM_ID.test(input.listingId)) deny('TRADING_ALIGN_TARGET_INVALID');
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1) {
    deny('TRADING_ALIGN_PAYLOAD_INVALID');
  }
  if (!PRICE_AMOUNT.test(input.price.value) || Number(input.price.value) <= 0
    || !CURRENCY.test(input.price.currency)) {
    deny('TRADING_ALIGN_PAYLOAD_INVALID');
  }
  const xml = '<?xml version="1.0" encoding="utf-8"?>'
    + '<RelistFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">'
    + '<Item>'
    + `<ItemID>${input.listingId}</ItemID>`
    + `<Quantity>${String(input.quantity)}</Quantity>`
    + `<StartPrice currencyID="${input.price.currency}">${input.price.value}</StartPrice>`
    + '</Item>'
    + '</RelistFixedPriceItemRequest>';
  if ((xml.match(/<ItemID>/g) ?? []).length !== 1
    || (xml.match(/<Quantity>/g) ?? []).length !== 1
    || (xml.match(/<StartPrice /g) ?? []).length !== 1) {
    deny('TRADING_ALIGN_PAYLOAD_INVALID');
  }
  return xml;
}

/**
 * Serialize the one bounded L99 price fallback: the exact ItemID, the one
 * StartPrice, and one DeletedField per named Best Offer threshold. Nothing
 * else may appear -- no Quantity, no other Item field, no other deletion --
 * so the fallback can never become a general listing revise.
 */
export function buildPriceWithBestOfferClearXml(input: Readonly<{
  listingId: string;
  price: Readonly<{ value: string; currency: string }>;
  clear: readonly BestOfferThresholdField[];
}>): string {
  if (!EXACT_ITEM_ID.test(input.listingId)) deny('TRADING_ALIGN_TARGET_INVALID');
  const { price } = input;
  if (!price || typeof price.value !== 'string' || !PRICE_AMOUNT.test(price.value)
    || Number(price.value) <= 0 || typeof price.currency !== 'string'
    || !CURRENCY.test(price.currency)) {
    deny('TRADING_ALIGN_PAYLOAD_INVALID');
  }
  const clear = [...new Set(input.clear)];
  if (clear.length === 0 || clear.some((field) => !BEST_OFFER_THRESHOLD_FIELD_SET.has(field))) {
    deny('TRADING_ALIGN_PAYLOAD_INVALID');
  }
  const xml = '<?xml version="1.0" encoding="utf-8"?>'
    + '<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">'
    + '<Item>'
    + `<ItemID>${input.listingId}</ItemID>`
    + `<StartPrice currencyID="${price.currency}">${price.value}</StartPrice>`
    + '</Item>'
    + clear.map((field) => `<DeletedField>${field}</DeletedField>`).join('')
    + '</ReviseFixedPriceItemRequest>';
  if ((xml.match(/<ItemID>/g) ?? []).length !== 1
    || (xml.match(/<StartPrice /g) ?? []).length !== 1
    || (xml.match(/<DeletedField>/g) ?? []).length !== clear.length
    || /<\/?Quantity\b/iu.test(xml)) {
    deny('TRADING_ALIGN_PAYLOAD_INVALID');
  }
  return xml;
}

type ProviderError = Readonly<{ code: string; severity: string; message: string }>;

/**
 * Which Best Offer thresholds a refused revise named. Only Error-severity
 * entries count; eBay's 23004 is the auto-accept code observed in
 * production, and the message text covers the auto-decline sibling.
 */
export function bestOfferThresholdsNamed(errors: readonly ProviderError[]): BestOfferThresholdField[] {
  const named = new Set<BestOfferThresholdField>();
  for (const error of errors) {
    if (error.severity !== 'Error') continue;
    if (error.code === '23004' || /auto\s*accept/iu.test(error.message)) {
      named.add(BEST_OFFER_THRESHOLD_FIELDS.autoAccept);
    }
    if (/MinimumBestOffer|auto\s*decline/iu.test(error.message)) {
      named.add(BEST_OFFER_THRESHOLD_FIELDS.autoDecline);
    }
  }
  return [...named];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createTradingAlignDispatchAdapter(dependencies: Readonly<{
  fetchImpl?: FetchLike;
  getAccessToken: () => Promise<string>;
}>): TradingAlignDispatchAdapter {
  const fetchImpl = dependencies.fetchImpl ?? fetch;

  async function accessToken(): Promise<string> {
    let token = '';
    try {
      token = await dependencies.getAccessToken();
    } catch {
      deny('TRADING_ALIGN_AUTHORITY_UNAVAILABLE');
    }
    if (typeof token !== 'string' || token.length === 0 || token.length > 4_096) {
      deny('TRADING_ALIGN_AUTHORITY_UNAVAILABLE');
    }
    return token;
  }

  async function boundedPost(body: string, callName: string): Promise<string> {
    const token = await accessToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(EBAY_TRADING_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml',
          'X-EBAY-API-COMPATIBILITY-LEVEL': EBAY_TRADING_COMPATIBILITY_LEVEL,
          'X-EBAY-API-CALL-NAME': callName,
          'X-EBAY-API-SITEID': EBAY_TRADING_SITE_ID,
          'X-EBAY-API-IAF-TOKEN': token,
        },
        body,
        redirect: 'error',
        signal: controller.signal,
      });
      const declaredLength = Number(response.headers.get('content-length') ?? '0');
      if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        deny('TRADING_ALIGN_WRITE_FAILED');
      }
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
        deny('TRADING_ALIGN_WRITE_FAILED');
      }
      if (response.status !== 200) deny('TRADING_ALIGN_WRITE_FAILED');
      return text;
    } catch (error) {
      if (error instanceof TradingAlignDispatchError) throw error;
      return deny('TRADING_ALIGN_WRITE_FAILED');
    } finally {
      clearTimeout(timeout);
    }
  }

  async function dispatchBoundedCall(body: string, callName: string): Promise<void> {
    await dispatchBoundedCallReturningBody(body, callName);
  }

  type ParsedResponse = Readonly<{
    text: string;
    accepted: boolean;
    errors: readonly ProviderError[];
  }>;

  async function postAndParse(body: string, callName: string): Promise<ParsedResponse> {
    if (Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD_BYTES) {
      deny('TRADING_ALIGN_PAYLOAD_TOO_LARGE');
    }
    const text = await boundedPost(body, callName);
    if (/<!DOCTYPE|<!ENTITY/iu.test(text)) deny('TRADING_ALIGN_REJECTED');
    let parsed: unknown;
    try {
      parsed = await parseStringPromise(text, {
        explicitArray: false,
        explicitRoot: true,
        trim: true,
        normalizeTags: false,
      });
    } catch {
      return deny('TRADING_ALIGN_REJECTED');
    }
    const response = isRecord(parsed)
      ? parsed[`${callName}Response`]
      : null;
    const ack = isRecord(response) ? response.Ack : null;
    const rawErrors = isRecord(response) ? response.Errors : undefined;
    const errors = (Array.isArray(rawErrors) ? rawErrors : rawErrors === undefined ? [] : [rawErrors])
      .filter(isRecord)
      .map((entry) => ({
        code: typeof entry.ErrorCode === 'string' ? entry.ErrorCode : '',
        severity: typeof entry.SeverityCode === 'string' ? entry.SeverityCode : '',
        message: [entry.ShortMessage, entry.LongMessage]
          .filter((part): part is string => typeof part === 'string').join(' '),
      }));
    return { text, accepted: ack === 'Success' || ack === 'Warning', errors };
  }

  function rejectWithReason(text: string, callName: string): never {
    // L84 (the L75 playbook): a bare TRADING_ALIGN_REJECTED hid eBay's
    // reason for WEEKS of 16437396 churn. Surface the sanitized error
    // text (token-shaped runs stripped, operator log only) so the next
    // rejection diagnoses itself.
    const errorText = /<Errors>[\s\S]{0,600}?<\/Errors>/u.exec(text)?.[0] ?? '';
    const sanitized = errorText
      .replace(/<[^>]+>/g, ' ')
      .replace(/[A-Za-z0-9+/=_-]{20,}/g, '…')
      .replace(/\s+/g, ' ')
      .slice(0, 300);
    console.warn(`EBAY_TRADING_REJECTED call=${callName} ${sanitized}`);
    // L87: persist the sanitized reason so incidents (and the fix agent,
    // which can never read server logs) receive eBay's own words.
    try {
      const file = '/data/product-pipeline/provider-rejections.json';
      let entries: Array<{ call: string; reason: string; atUtc: string }> = [];
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
        if (Array.isArray(parsed)) entries = parsed as typeof entries;
      } catch { /* fresh */ }
      entries.push({ call: callName, reason: sanitized, atUtc: new Date().toISOString() });
      fs.writeFileSync(file, JSON.stringify(entries.slice(-20)));
    } catch { /* best effort */ }
    return deny('TRADING_ALIGN_REJECTED');
  }

  async function dispatchBoundedCallReturningBody(body: string, callName: string): Promise<string> {
    const result = await postAndParse(body, callName);
    if (!result.accepted) rejectWithReason(result.text, callName);
    return result.text;
  }

  async function reviseInventoryStatus(input: TradingAlignInput): Promise<TradingAlignResult> {
    const first = await postAndParse(buildReviseInventoryStatusXml(input), EBAY_TRADING_CALL_NAME);
    if (first.accepted) return { clearedBestOfferThresholds: [] };
    const clear = input.field === 'price' ? bestOfferThresholdsNamed(first.errors) : [];
    if (input.field !== 'price' || clear.length === 0) {
      return rejectWithReason(first.text, EBAY_TRADING_CALL_NAME);
    }
    // L99 (incident #178): eBay refused the price because the listing's
    // Best Offer auto-accept (or auto-decline) threshold is not below it.
    // The refusal changed nothing, so one ReviseFixedPriceItem sets the
    // same approved price and deletes only the named threshold(s). Deleting
    // rather than lowering means nothing auto-sells at a price the operator
    // never chose: Best Offer stays on and every offer reaches the seller.
    // A refusal of the fallback is reported exactly like any rejection.
    console.warn(`EBAY_BEST_OFFER_THRESHOLD_CLEARING listing=${input.listingId} `
      + `fields=${clear.join(',')}`);
    await dispatchBoundedCall(
      buildPriceWithBestOfferClearXml({ listingId: input.listingId, price: input.price, clear }),
      EBAY_TRADING_REVISE_FIXED_CALL_NAME,
    );
    return { clearedBestOfferThresholds: clear };
  }

  async function endFixedPriceItem(input: Readonly<{ listingId: string }>): Promise<void> {
    await dispatchBoundedCall(buildEndFixedPriceItemXml(input), EBAY_TRADING_END_CALL_NAME);
  }

  async function relistFixedPriceItem(input: Readonly<{
    listingId: string;
    quantity: number;
    price: Readonly<{ value: string; currency: string }>;
  }>): Promise<string> {
    const text = await dispatchBoundedCallReturningBody(
      buildRelistFixedPriceItemXml(input),
      EBAY_TRADING_RELIST_CALL_NAME,
    );
    // The response's ItemID is the NEW listing eBay created.
    const newListingId = /<ItemID>([0-9]{6,20})<\/ItemID>/u.exec(text)?.[1];
    if (!newListingId) deny('TRADING_ALIGN_REJECTED');
    return newListingId as string;
  }

  return Object.freeze({ reviseInventoryStatus, endFixedPriceItem, relistFixedPriceItem });
}
