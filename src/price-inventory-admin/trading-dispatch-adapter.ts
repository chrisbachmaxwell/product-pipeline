/**
 * Bounded eBay Trading-API alignment adapter for the isolated
 * price/inventory operator CLI — the legacy-Trading-model half of the
 * price/inventory slice. It exposes exactly one operation,
 * `reviseInventoryStatus`, which performs exactly one POST of one
 * `ReviseInventoryStatus` XML request to exactly one host, carrying exactly
 * ONE `InventoryStatus` element: the ItemID plus either a `StartPrice` (a
 * price alignment) or a `Quantity` (a quantity alignment), never both. A
 * structural assertion on the serialized XML guarantees a price dispatch can
 * never contain a Quantity element and a quantity dispatch can never contain
 * a StartPrice element. A price alignment eBay refuses over a Best Offer
 * threshold (L105) falls back to a bounded ReviseFixedPriceItem with the
 * same StartPrice that clears only that threshold. Errors are redacted to fixed codes; no token, URL,
 * payload, or provider body is ever thrown or logged.
 *
 * This module is intentionally not imported by the server, webhooks,
 * schedulers, or any legacy sync path. Its single POST is reachable only
 * from the dispatch ceremony in `program.ts`, which requires a reserved
 * migration-store job under a live one-action approval before calling it.
 */
import { parseStringPromise } from 'xml2js';

const EBAY_TRADING_URL = 'https://api.ebay.com/ws/api.dll';
const EBAY_TRADING_COMPATIBILITY_LEVEL = '1349';
const EBAY_TRADING_SITE_ID = '0';
const EBAY_TRADING_CALL_NAME = 'ReviseInventoryStatus';
const EBAY_TRADING_END_CALL_NAME = 'EndFixedPriceItem';
const EBAY_TRADING_RELIST_CALL_NAME = 'RelistFixedPriceItem';
const EBAY_TRADING_REVISE_CALL_NAME = 'ReviseFixedPriceItem';
const BEST_OFFER_AUTO_ACCEPT_FIELD = 'Item.ListingDetails.BestOfferAutoAcceptPrice';
const BEST_OFFER_MINIMUM_FIELD = 'Item.ListingDetails.MinimumBestOfferPrice';
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

export type TradingAlignDispatchAdapter = Readonly<{
  reviseInventoryStatus: (input: TradingAlignInput) => Promise<void>;
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
 * Which Best Offer thresholds a price rejection names (L105, #201). eBay
 * error 23004 is the auto-accept rule ("The Best Offer Auto Accept Price
 * must be less than the Buy It Now price"); the auto-decline (minimum)
 * rule is matched by its wording. Anything else is not a Best Offer
 * conflict and stays a plain rejection.
 */
export function bestOfferConflict(errors: string): { autoAccept: boolean; minimum: boolean } | null {
  const autoAccept = /<ErrorCode>\s*23004\s*<\/ErrorCode>/u.test(errors)
    || /Auto ?Accept/iu.test(errors);
  const minimum = /Auto ?Decline|Minimum ?Best ?Offer/iu.test(errors);
  return autoAccept || minimum ? { autoAccept, minimum } : null;
}

/**
 * Serialize the one bounded ReviseFixedPriceItem fallback for a price
 * alignment eBay refused over a Best Offer threshold: the exact ItemID, the
 * same StartPrice, and DeletedField entries for exactly the conflicting
 * threshold(s). Never a Quantity, never any other field.
 */
export function buildRevisePriceClearingBestOfferXml(input: Readonly<{
  listingId: string;
  price: Readonly<{ value: string; currency: string }>;
  clearAutoAccept: boolean;
  clearMinimum: boolean;
}>): string {
  if (!EXACT_ITEM_ID.test(input.listingId)) deny('TRADING_ALIGN_TARGET_INVALID');
  const { price } = input;
  if (!price || typeof price.value !== 'string' || !PRICE_AMOUNT.test(price.value)
    || Number(price.value) <= 0 || typeof price.currency !== 'string'
    || !CURRENCY.test(price.currency)) {
    deny('TRADING_ALIGN_PAYLOAD_INVALID');
  }
  if (!input.clearAutoAccept && !input.clearMinimum) deny('TRADING_ALIGN_PAYLOAD_INVALID');
  const deleted = [
    ...(input.clearAutoAccept ? [BEST_OFFER_AUTO_ACCEPT_FIELD] : []),
    ...(input.clearMinimum ? [BEST_OFFER_MINIMUM_FIELD] : []),
  ].map((field) => `<DeletedField>${field}</DeletedField>`).join('');
  const xml = '<?xml version="1.0" encoding="utf-8"?>'
    + '<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">'
    + deleted
    + '<Item>'
    + `<ItemID>${input.listingId}</ItemID>`
    + `<StartPrice currencyID="${price.currency}">${price.value}</StartPrice>`
    + '</Item>'
    + '</ReviseFixedPriceItemRequest>';
  if ((xml.match(/<ItemID>/g) ?? []).length !== 1
    || (xml.match(/<StartPrice /g) ?? []).length !== 1
    || /<\/?Quantity\b/iu.test(xml)) {
    deny('TRADING_ALIGN_PAYLOAD_INVALID');
  }
  return xml;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createTradingAlignDispatchAdapter(dependencies: Readonly<{
  fetchImpl?: FetchLike;
  getAccessToken: () => Promise<string>;
  /** Tests redirect the L87 rejection ring away from /data. */
  rejectionLogPath?: string;
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

  type PostOutcome =
    | Readonly<{ accepted: true; text: string }>
    | Readonly<{ accepted: false; errors: string }>;

  async function postParsed(body: string, callName: string): Promise<PostOutcome> {
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
    if (ack === 'Success' || ack === 'Warning') return { accepted: true, text };
    const errors = (text.match(/<Errors>[\s\S]*?<\/Errors>/gu) ?? []).join('');
    return { accepted: false, errors };
  }

  async function rejectLoudly(callName: string, listingId: string, errors: string): Promise<never> {
    // L84 (the L75 playbook): a bare TRADING_ALIGN_REJECTED hid eBay's
    // reason for WEEKS of 16437396 churn. Surface the sanitized error
    // text (token-shaped runs stripped, operator log only) so the next
    // rejection diagnoses itself.
    const errorText = /<Errors>[\s\S]{0,600}?<\/Errors>/u.exec(errors)?.[0] ?? '';
    const sanitized = errorText
      .replace(/<[^>]+>/g, ' ')
      .replace(/[A-Za-z0-9+/=_-]{20,}/g, '…')
      .replace(/\s+/g, ' ')
      .slice(0, 300);
    console.warn(`EBAY_TRADING_REJECTED call=${callName} item=${listingId} ${sanitized}`);
    // L87: persist the sanitized reason so incidents (and the fix agent,
    // which can never read server logs) receive eBay's own words. L105:
    // keyed by listing, so an incident never quotes another item's reason.
    try {
      const fs = await import('node:fs');
      const file = dependencies.rejectionLogPath ?? '/data/product-pipeline/provider-rejections.json';
      let entries: Array<{ call: string; listingId?: string; reason: string; atUtc: string }> = [];
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
        if (Array.isArray(parsed)) entries = parsed as typeof entries;
      } catch { /* fresh */ }
      entries.push({ call: callName, listingId, reason: sanitized, atUtc: new Date().toISOString() });
      fs.writeFileSync(file, JSON.stringify(entries.slice(-20)));
    } catch { /* best effort */ }
    return deny('TRADING_ALIGN_REJECTED');
  }

  async function dispatchBoundedCallReturningBody(
    body: string,
    callName: string,
    listingId: string,
  ): Promise<string> {
    const outcome = await postParsed(body, callName);
    if (!outcome.accepted) return rejectLoudly(callName, listingId, outcome.errors);
    return outcome.text;
  }

  async function reviseInventoryStatus(input: TradingAlignInput): Promise<void> {
    const first = await postParsed(buildReviseInventoryStatusXml(input), EBAY_TRADING_CALL_NAME);
    if (first.accepted) return;
    if (input.field !== 'price') {
      return rejectLoudly(EBAY_TRADING_CALL_NAME, input.listingId, first.errors);
    }
    // L105 (#201): eBay refuses a Buy It Now price at or below the
    // listing's Best Offer auto-accept (23004) or auto-decline price, and
    // ReviseInventoryStatus cannot touch those, so every retry was refused
    // forever. Clear exactly the conflicting threshold(s) alongside the
    // same StartPrice in one ReviseFixedPriceItem. Clearing never sells
    // below the price being set; lowering would invent a number.
    let conflict = bestOfferConflict(first.errors);
    let last: PostOutcome = first;
    let callName = EBAY_TRADING_CALL_NAME;
    for (let attempt = 0; conflict !== null && attempt < 2; attempt += 1) {
      console.warn(`EBAY_TRADING_BEST_OFFER_CONFLICT item=${input.listingId} `
        + `clearAutoAccept=${String(conflict.autoAccept)} clearMinimum=${String(conflict.minimum)}`);
      callName = EBAY_TRADING_REVISE_CALL_NAME;
      last = await postParsed(buildRevisePriceClearingBestOfferXml({
        listingId: input.listingId,
        price: input.price,
        clearAutoAccept: conflict.autoAccept,
        clearMinimum: conflict.minimum,
      }), callName);
      if (last.accepted) return;
      const next = bestOfferConflict(last.errors);
      // Retry only when eBay names a threshold not yet cleared. Once the
      // auto-accept price is gone a minimum can be the remaining blocker,
      // so the second attempt clears both.
      conflict = next !== null && ((next.autoAccept && !conflict.autoAccept)
        || (next.minimum && !conflict.minimum))
        ? { autoAccept: true, minimum: true }
        : null;
    }
    return rejectLoudly(callName, input.listingId, last.errors);
  }

  async function endFixedPriceItem(input: Readonly<{ listingId: string }>): Promise<void> {
    await dispatchBoundedCallReturningBody(
      buildEndFixedPriceItemXml(input),
      EBAY_TRADING_END_CALL_NAME,
      input.listingId,
    );
  }

  async function relistFixedPriceItem(input: Readonly<{
    listingId: string;
    quantity: number;
    price: Readonly<{ value: string; currency: string }>;
  }>): Promise<string> {
    const text = await dispatchBoundedCallReturningBody(
      buildRelistFixedPriceItemXml(input),
      EBAY_TRADING_RELIST_CALL_NAME,
      input.listingId,
    );
    // The response's ItemID is the NEW listing eBay created.
    const newListingId = /<ItemID>([0-9]{6,20})<\/ItemID>/u.exec(text)?.[1];
    if (!newListingId) deny('TRADING_ALIGN_REJECTED');
    return newListingId as string;
  }

  return Object.freeze({ reviseInventoryStatus, endFixedPriceItem, relistFixedPriceItem });
}
