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
 * a StartPrice element. (A price alignment that collides with the listing's
 * Best Offer floors instead uses one bounded ReviseFixedPriceItem carrying
 * only the price and the lowered floors -- L105.) Errors are redacted to
 * fixed codes; no token, URL,
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
const EBAY_TRADING_REVISE_ITEM_CALL_NAME = 'ReviseFixedPriceItem';
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
   * A price alignment that must also lower the listing's Best Offer
   * auto-accept / minimum floors in the same call (L105): eBay refuses a Buy
   * It Now price at or below either floor, and ReviseInventoryStatus cannot
   * carry them. Exactly one bounded ReviseFixedPriceItem POST.
   */
  revisePriceWithBestOfferFloors: (input: Readonly<{
    listingId: string;
    price: Readonly<{ value: string; currency: string }>;
    floors: TradingBestOfferFloors;
  }>) => Promise<void>;
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

export type TradingBestOfferFloors = Readonly<{
  autoAccept: Readonly<{ value: string; currency: string }> | null;
  minimum: Readonly<{ value: string; currency: string }> | null;
}>;

/**
 * Serialize the one bounded ReviseFixedPriceItem request for a price
 * alignment that collides with the listing's Best Offer floors (L105): the
 * exact ItemID, the new StartPrice, and the lowered
 * `ListingDetails.BestOfferAutoAcceptPrice` / `MinimumBestOfferPrice` --
 * nothing else, so eBay keeps every other listing field. Same strict
 * grammars as the revise serializer; each floor must sit strictly below the
 * price (and the minimum below auto-accept), in the price's currency, so
 * eBay's 23004 rule holds by construction. No Quantity element can appear.
 */
export function buildRevisePriceWithBestOfferFloorsXml(input: Readonly<{
  listingId: string;
  price: Readonly<{ value: string; currency: string }>;
  floors: TradingBestOfferFloors;
}>): string {
  if (!EXACT_ITEM_ID.test(input.listingId)) deny('TRADING_ALIGN_TARGET_INVALID');
  const { price, floors } = input;
  const validMoney = (money: Readonly<{ value: string; currency: string }> | null): boolean =>
    money !== null && typeof money.value === 'string' && PRICE_AMOUNT.test(money.value)
    && Number(money.value) > 0 && money.currency === price.currency;
  if (!price || typeof price.currency !== 'string' || !CURRENCY.test(price.currency)
    || !validMoney(price) || !floors
    || (floors.autoAccept === null && floors.minimum === null)
    || (floors.autoAccept !== null && (!validMoney(floors.autoAccept)
      || Number(floors.autoAccept.value) >= Number(price.value)))
    || (floors.minimum !== null && (!validMoney(floors.minimum)
      || Number(floors.minimum.value) >= Number((floors.autoAccept ?? price).value)))) {
    deny('TRADING_ALIGN_PAYLOAD_INVALID');
  }
  const autoAccept = floors.autoAccept === null ? ''
    : `<BestOfferAutoAcceptPrice currencyID="${price.currency}">${floors.autoAccept.value}</BestOfferAutoAcceptPrice>`;
  const minimum = floors.minimum === null ? ''
    : `<MinimumBestOfferPrice currencyID="${price.currency}">${floors.minimum.value}</MinimumBestOfferPrice>`;
  const xml = '<?xml version="1.0" encoding="utf-8"?>'
    + '<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">'
    + '<Item>'
    + `<ItemID>${input.listingId}</ItemID>`
    + `<StartPrice currencyID="${price.currency}">${price.value}</StartPrice>`
    + `<ListingDetails>${autoAccept}${minimum}</ListingDetails>`
    + '</Item>'
    + '</ReviseFixedPriceItemRequest>';
  if ((xml.match(/<ItemID>/g) ?? []).length !== 1
    || (xml.match(/<StartPrice /g) ?? []).length !== 1
    || /<\/?Quantity\b/iu.test(xml)) {
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

const PROVIDER_REJECTIONS_FILE = '/data/product-pipeline/provider-rejections.json';
const MAX_REJECTION_REASON_CHARACTERS = 300;

function sanitizeProviderText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/[A-Za-z0-9+/=_-]{20,}/g, '…')
    .replace(/\s+/g, ' ')
    .trim();
}

function xmlText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value._ === 'string') return value._;
  return '';
}

/**
 * eBay's own reason for a non-Ack Trading response, sanitized for the
 * operator log and the incident (L87). Never empty (incident #209: the old
 * `<Errors>[\s\S]{0,600}?</Errors>` window found nothing whenever eBay's
 * error block ran past 600 characters, so the incident quoted an empty
 * reason). Reads every error-severity `<Errors>` entry from the parsed
 * response (warnings only when no error is present), keeps the ErrorCode,
 * ShortMessage and LongMessage, and says plainly when the response carried
 * no `<Errors>` at all.
 */
export function describeTradingRejection(input: Readonly<{
  text: string;
  callName: string;
  response: unknown;
}>): string {
  const rawErrors = isRecord(input.response) ? input.response.Errors : undefined;
  const errors = (Array.isArray(rawErrors) ? rawErrors : [rawErrors]).filter(isRecord);
  const failing = errors.filter((entry) => xmlText(entry.SeverityCode) !== 'Warning');
  const parts = (failing.length > 0 ? failing : errors).map((entry) => {
    const code = xmlText(entry.ErrorCode).trim();
    const short = xmlText(entry.ShortMessage).trim();
    const long = xmlText(entry.LongMessage).trim();
    const message = long === '' || long === short ? short : short === '' ? long : `${short}: ${long}`;
    return `${code === '' ? '' : `[${code}] `}${message}`.trim();
  }).filter((part) => part !== '');
  let reason = sanitizeProviderText(parts.join(' | '));
  if (reason === '') {
    // Unparsed shape: fall back to the raw blocks, with no length window.
    reason = sanitizeProviderText((input.text.match(/<Errors>[\s\S]*?<\/Errors>/gu) ?? []).join(' | '));
  }
  if (reason === '') {
    const ack = isRecord(input.response) ? xmlText(input.response.Ack) : '';
    reason = isRecord(input.response)
      ? `eBay returned Ack=${ack === '' ? 'missing' : sanitizeProviderText(ack)} with no <Errors> detail`
      : `eBay's reply was not a ${input.callName}Response`;
  }
  return reason.slice(0, MAX_REJECTION_REASON_CHARACTERS);
}

export function createTradingAlignDispatchAdapter(dependencies: Readonly<{
  fetchImpl?: FetchLike;
  getAccessToken: () => Promise<string>;
  /** Test seam; production persists to the L87 ring on the data volume. */
  providerRejectionsFile?: string;
}>): TradingAlignDispatchAdapter {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const providerRejectionsFile = dependencies.providerRejectionsFile ?? PROVIDER_REJECTIONS_FILE;

  // L87: persist the sanitized reason so incidents (and the fix agent,
  // which can never read server logs) receive eBay's own words. The listing
  // id lets the watchdog quote THIS listing's reason, not whichever
  // rejection happened last (#209).
  async function recordProviderRejection(callName: string, listingId: string, reason: string) {
    try {
      const fs = await import('node:fs');
      let entries: Array<{ call: string; listingId?: string; reason: string; atUtc: string }> = [];
      try {
        const parsed = JSON.parse(fs.readFileSync(providerRejectionsFile, 'utf8')) as unknown;
        if (Array.isArray(parsed)) entries = parsed as typeof entries;
      } catch { /* fresh */ }
      entries.push({ call: callName, listingId, reason, atUtc: new Date().toISOString() });
      fs.writeFileSync(providerRejectionsFile, JSON.stringify(entries.slice(-20)));
    } catch { /* best effort */ }
  }

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

  async function dispatchBoundedCall(body: string, callName: string, listingId: string): Promise<void> {
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
      const sanitized = describeTradingRejection({ text, callName, response });
      console.warn(`EBAY_TRADING_REJECTED call=${callName} item=${listingId} ${sanitized}`);
      await recordProviderRejection(callName, listingId, sanitized);
      deny('TRADING_ALIGN_REJECTED');
    }
    return text;
  }

  async function reviseInventoryStatus(input: TradingAlignInput): Promise<void> {
    await dispatchBoundedCall(
      buildReviseInventoryStatusXml(input),
      EBAY_TRADING_CALL_NAME,
      input.listingId,
    );
  }

  async function revisePriceWithBestOfferFloors(input: Readonly<{
    listingId: string;
    price: Readonly<{ value: string; currency: string }>;
    floors: TradingBestOfferFloors;
  }>): Promise<void> {
    await dispatchBoundedCall(
      buildRevisePriceWithBestOfferFloorsXml(input),
      EBAY_TRADING_REVISE_ITEM_CALL_NAME,
    );
  }

  async function endFixedPriceItem(input: Readonly<{ listingId: string }>): Promise<void> {
    await dispatchBoundedCall(
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

  return Object.freeze({
    reviseInventoryStatus,
    revisePriceWithBestOfferFloors,
    endFixedPriceItem,
    relistFixedPriceItem,
  });
}
