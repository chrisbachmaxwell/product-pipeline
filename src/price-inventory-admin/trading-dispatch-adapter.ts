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
 * a StartPrice element. Errors are redacted to fixed codes; no token, URL,
 * payload, or provider body is ever thrown or logged.
 *
 * L103: a price change that would cross the listing's Best Offer Auto-Accept
 * or Minimum price (eBay error 23004) is instead sent as ONE
 * ReviseFixedPriceItem carrying the price and the scaled thresholds, never a
 * Quantity. The thresholds come from a read-only GetItem made just before.
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
const EBAY_TRADING_REVISE_ITEM_CALL_NAME = 'ReviseFixedPriceItem';
const EBAY_TRADING_GET_ITEM_CALL_NAME = 'GetItem';
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
  /**
   * READ-ONLY: the listing's Best Offer thresholds (L103). eBay refuses any
   * price at or below the Auto-Accept (error 23004) or Minimum offer price,
   * so a price drop across either line needs them moved in the same write.
   * Returns null when the read fails; it never writes.
   */
  readBestOfferThresholds: (input: Readonly<{ listingId: string }>) =>
    Promise<BestOfferThresholds | null>;
  /**
   * Revise ONE listing's price together with its Best Offer thresholds in a
   * single ReviseFixedPriceItem (L103). Used only when the new price would
   * cross a threshold; carries no Quantity and no other Item field.
   */
  revisePriceWithBestOffer: (input: BestOfferPriceRevision) => Promise<void>;
}>;

export type BestOfferThresholds = Readonly<{
  autoAccept: Readonly<{ value: string; currency: string }> | null;
  minimum: Readonly<{ value: string; currency: string }> | null;
}>;

export type BestOfferPriceRevision = Readonly<{
  listingId: string;
  price: Readonly<{ value: string; currency: string }>;
  autoAccept: Readonly<{ value: string; currency: string }> | null;
  minimum: Readonly<{ value: string; currency: string }> | null;
}>;

const cents = (value: string): number => Math.round(Number(value) * 100);
const fromCents = (amount: number): string => (amount / 100).toFixed(2);

/**
 * L103 policy: when the new price would sit at or below the Best Offer
 * Auto-Accept or Minimum price (eBay 23004 and siblings), scale BOTH
 * thresholds by the same factor as the price, so the seller's chosen
 * discount ratio survives the price change, and keep each strictly below
 * the price (and Minimum strictly below Auto-Accept). Returns null when no
 * threshold conflicts (the plain ReviseInventoryStatus path is used), and
 * also when the inputs cannot be made coherent (the plain path then fails
 * visibly with eBay's own reason, as before).
 */
export function planBestOfferAdjustment(input: Readonly<{
  thresholds: BestOfferThresholds | null;
  previousPrice: Readonly<{ value: string; currency: string }> | null;
  newPrice: Readonly<{ value: string; currency: string }>;
}>): Readonly<{ autoAccept: BestOfferThresholds['autoAccept']; minimum: BestOfferThresholds['minimum'] }> | null {
  const { thresholds, previousPrice, newPrice } = input;
  if (thresholds === null) return null;
  const valid = (money: { value: string; currency: string } | null): boolean =>
    money !== null && PRICE_AMOUNT.test(money.value) && money.currency === newPrice.currency;
  if (!PRICE_AMOUNT.test(newPrice.value)) return null;
  const next = cents(newPrice.value);
  const autoAccept = valid(thresholds.autoAccept) ? cents(thresholds.autoAccept!.value) : null;
  const minimum = valid(thresholds.minimum) ? cents(thresholds.minimum!.value) : null;
  const conflict = (autoAccept !== null && autoAccept >= next)
    || (minimum !== null && minimum >= next);
  if (!conflict) return null;
  if (previousPrice === null || !valid(previousPrice) || next <= 2) return null;
  const previous = cents(previousPrice.value);
  if (previous <= 0) return null;
  const scale = (amount: number): number => Math.floor((amount * next) / previous);
  let scaledAutoAccept = autoAccept === null ? null : Math.min(scale(autoAccept), next - 1);
  let scaledMinimum = minimum === null ? null : Math.min(scale(minimum), next - 1);
  if (scaledAutoAccept !== null && scaledMinimum !== null && scaledMinimum >= scaledAutoAccept) {
    scaledMinimum = scaledAutoAccept - 1;
  }
  if ((scaledAutoAccept !== null && scaledAutoAccept <= 0)
    || (scaledMinimum !== null && scaledMinimum <= 0)) {
    return null;
  }
  const money = (amount: number | null) => amount === null
    ? null
    : Object.freeze({ value: fromCents(amount), currency: newPrice.currency });
  return Object.freeze({ autoAccept: money(scaledAutoAccept), minimum: money(scaledMinimum) });
}

/**
 * Serialize the one bounded ReviseFixedPriceItem request for a price change
 * that must move the Best Offer thresholds with it: exactly one ItemID, one
 * StartPrice, and the ListingDetails threshold elements. Every threshold
 * must be strictly below the price (and Minimum below Auto-Accept), and the
 * document may never carry a Quantity -- the same cross-contamination rule
 * as the ReviseInventoryStatus path.
 */
export function buildReviseFixedPricePriceXml(input: BestOfferPriceRevision): string {
  if (!EXACT_ITEM_ID.test(input.listingId)) deny('TRADING_ALIGN_TARGET_INVALID');
  const money = (value: { value: string; currency: string } | null): boolean =>
    value !== null && typeof value.value === 'string' && PRICE_AMOUNT.test(value.value)
    && Number(value.value) > 0 && typeof value.currency === 'string'
    && value.currency === input.price.currency && CURRENCY.test(value.currency);
  if (!money(input.price)) deny('TRADING_ALIGN_PAYLOAD_INVALID');
  if (input.autoAccept === null && input.minimum === null) deny('TRADING_ALIGN_PAYLOAD_INVALID');
  const price = cents(input.price.value);
  for (const threshold of [input.autoAccept, input.minimum]) {
    if (threshold !== null && (!money(threshold) || cents(threshold.value) >= price)) {
      deny('TRADING_ALIGN_PAYLOAD_INVALID');
    }
  }
  if (input.autoAccept !== null && input.minimum !== null
    && cents(input.minimum.value) >= cents(input.autoAccept.value)) {
    deny('TRADING_ALIGN_PAYLOAD_INVALID');
  }
  const element = (name: string, value: { value: string; currency: string } | null): string =>
    value === null ? '' : `<${name} currencyID="${value.currency}">${value.value}</${name}>`;
  const xml = '<?xml version="1.0" encoding="utf-8"?>'
    + '<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">'
    + '<Item>'
    + `<ItemID>${input.listingId}</ItemID>`
    + element('StartPrice', input.price)
    + '<ListingDetails>'
    + element('BestOfferAutoAcceptPrice', input.autoAccept)
    + element('MinimumBestOfferPrice', input.minimum)
    + '</ListingDetails>'
    + '</Item>'
    + '</ReviseFixedPriceItemRequest>';
  if ((xml.match(/<ItemID>/g) ?? []).length !== 1
    || (xml.match(/<StartPrice /g) ?? []).length !== 1
    || /<\/?Quantity\b/iu.test(xml)) {
    deny('TRADING_ALIGN_PAYLOAD_INVALID');
  }
  return xml;
}

/** Serialize the read-only GetItem request for one exact listing. */
export function buildGetItemThresholdsXml(input: Readonly<{ listingId: string }>): string {
  if (!EXACT_ITEM_ID.test(input.listingId)) deny('TRADING_ALIGN_TARGET_INVALID');
  return '<?xml version="1.0" encoding="utf-8"?>'
    + '<GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">'
    + '<DetailLevel>ReturnAll</DetailLevel>'
    + `<ItemID>${input.listingId}</ItemID>`
    + '</GetItemRequest>';
}

/** Extract the two Best Offer thresholds from a parsed GetItem response. */
export function parseBestOfferThresholds(
  parsed: unknown,
  listingId: string,
): BestOfferThresholds | null {
  const response = isRecord(parsed) ? parsed.GetItemResponse : null;
  if (!isRecord(response) || (response.Ack !== 'Success' && response.Ack !== 'Warning')) {
    return null;
  }
  const item = isRecord(response.Item) ? response.Item : null;
  if (item === null || item.ItemID !== listingId) return null;
  const details = isRecord(item.ListingDetails) ? item.ListingDetails : {};
  const money = (raw: unknown): { value: string; currency: string } | null => {
    if (!isRecord(raw)) return null;
    const value = typeof raw._ === 'string' ? raw._ : null;
    const attributes = isRecord(raw.$) ? raw.$ : {};
    const currency = typeof attributes.currencyID === 'string' ? attributes.currencyID : null;
    if (value === null || currency === null || !CURRENCY.test(currency)) return null;
    // eBay may render 159.95 as "159.95" or "159.950"; normalize to cents.
    if (!/^[0-9]{1,10}(\.[0-9]{1,3})?$/u.test(value) || Number(value) <= 0) return null;
    return Object.freeze({ value: Number(value).toFixed(2), currency });
  };
  return Object.freeze({
    autoAccept: money(details.BestOfferAutoAcceptPrice),
    minimum: money(details.MinimumBestOfferPrice),
  });
}

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

  async function dispatchBoundedCall(
    body: string,
    callName: string,
    listingId: string,
  ): Promise<void> {
    await dispatchBoundedCallReturningBody(body, callName, listingId);
  }

  async function dispatchBoundedCallReturningBody(
    body: string,
    callName: string,
    listingId: string,
  ): Promise<string> {
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
    if (ack !== 'Success' && ack !== 'Warning') {
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
        const fs = await import('node:fs');
        const file = '/data/product-pipeline/provider-rejections.json';
        let entries: Array<{
          call: string; listingId?: string; reason: string; atUtc: string;
        }> = [];
        try {
          const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
          if (Array.isArray(parsed)) entries = parsed as typeof entries;
        } catch { /* fresh */ }
        // L103: the listing id lets the watchdog quote THIS listing's
        // rejection instead of whichever listing was rejected last.
        entries.push({
          call: callName, listingId, reason: sanitized, atUtc: new Date().toISOString(),
        });
        fs.writeFileSync(file, JSON.stringify(entries.slice(-20)));
      } catch { /* best effort */ }
      deny('TRADING_ALIGN_REJECTED');
    }
    return text;
  }

  async function reviseInventoryStatus(input: TradingAlignInput): Promise<void> {
    await dispatchBoundedCall(
      buildReviseInventoryStatusXml(input), EBAY_TRADING_CALL_NAME, input.listingId,
    );
  }

  async function endFixedPriceItem(input: Readonly<{ listingId: string }>): Promise<void> {
    await dispatchBoundedCall(
      buildEndFixedPriceItemXml(input), EBAY_TRADING_END_CALL_NAME, input.listingId,
    );
  }

  async function readBestOfferThresholds(
    input: Readonly<{ listingId: string }>,
  ): Promise<BestOfferThresholds | null> {
    try {
      const text = await boundedPost(
        buildGetItemThresholdsXml(input), EBAY_TRADING_GET_ITEM_CALL_NAME,
      );
      if (/<!DOCTYPE|<!ENTITY/iu.test(text)) return null;
      const parsed = await parseStringPromise(text, {
        explicitArray: false, explicitRoot: true, trim: true, normalizeTags: false,
      });
      return parseBestOfferThresholds(parsed, input.listingId);
    } catch {
      return null;
    }
  }

  async function revisePriceWithBestOffer(input: BestOfferPriceRevision): Promise<void> {
    await dispatchBoundedCall(
      buildReviseFixedPricePriceXml(input),
      EBAY_TRADING_REVISE_ITEM_CALL_NAME,
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

  return Object.freeze({
    reviseInventoryStatus,
    endFixedPriceItem,
    relistFixedPriceItem,
    readBestOfferThresholds,
    revisePriceWithBestOffer,
  });
}
