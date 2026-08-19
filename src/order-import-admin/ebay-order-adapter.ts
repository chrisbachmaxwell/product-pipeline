/**
 * Bounded read-only eBay Fulfillment adapter for the isolated order-import
 * operator CLI. It can reach exactly one host and exactly one resource family
 * (`/sell/fulfillment/v1/order`) with exactly one method (GET). Every other
 * host, path, or method is structurally impossible. Errors are redacted to
 * fixed codes; no token, URL, payload, or provider body is ever thrown or
 * logged.
 *
 * PII boundary: the adapter extracts ONLY the fields the ceremony needs.
 * Poll reads never touch buyer data at all. The single-order read used by
 * `import` additionally extracts a shipping pass-through block that exists
 * only in process memory for the one Shopify provider call — it is never
 * persisted, logged, digested into stored payloads, or echoed in output.
 *
 * This module is intentionally not imported by the server, webhooks,
 * schedulers, or any legacy sync path.
 */
import {
  createTransientEbayTokenProvider,
  type RuntimeAuthMaterial,
} from '../server/live-listing-catalog-source.js';
import { loadEbayCredentials } from '../config/credentials.js';
import { openShadowDatabase } from '../server/shadow-db.js';

const EBAY_API_HOST = 'https://api.ebay.com';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_LIST_PAGES = 3;
const MAX_PAGE_LIMIT = 50;
const SAFE_ORDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The exact transient token scope pair for the order-read boundary: the base
 * scope plus sell.fulfillment, nothing else. The exchange fails closed when
 * the provider echoes any other scope set.
 */
export const EBAY_ORDER_TOKEN_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
] as const;

export class EbayOrderReadError extends Error {
  constructor(readonly code:
    | 'ORDER_READ_AUTHORITY_UNAVAILABLE'
    | 'ORDER_READ_TARGET_INVALID'
    | 'ORDER_READ_FAILED') {
    super('eBay order read adapter failed');
    this.name = 'EbayOrderReadError';
  }
}

const deny = (code: ConstructorParameters<typeof EbayOrderReadError>[0]): never => {
  throw new EbayOrderReadError(code);
};

type FetchLike = typeof fetch;

export type PolledEbayOrderLineItem = Readonly<{
  lineItemId: string;
  sku: string | null;
  title: string;
  quantity: number;
  cost: Readonly<{ value: string; currency: string }> | null;
}>;

export type PolledEbayOrder = Readonly<{
  orderId: string;
  creationDateUtc: string;
  fulfillmentStatus: string;
  paymentStatus: string;
  total: Readonly<{ value: string; currency: string }> | null;
  lineItems: readonly PolledEbayOrderLineItem[];
}>;

/**
 * Shipping details pass through to exactly one Shopify provider call and are
 * never persisted, logged, or included in any stored or printed payload.
 */
export type EbayShippingPassthrough = Readonly<{
  fullName: string | null;
  email: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  stateOrProvince: string | null;
  postalCode: string | null;
  countryCode: string | null;
}>;

export type FetchedEbayOrder = PolledEbayOrder & Readonly<{
  shippingPassthrough: EbayShippingPassthrough | null;
}>;

export type EbayOrderReadAdapter = Readonly<{
  /** GET /sell/fulfillment/v1/order filtered to creationdate:[since..]. */
  listOrdersCreatedSince: (sinceUtc: string, maxOrders: number) => Promise<PolledEbayOrder[]>;
  /** GET /sell/fulfillment/v1/order/{orderId} — one fresh order. */
  getOrder: (orderId: string) => Promise<FetchedEbayOrder>;
}>;

function safeText(value: unknown, maximum = 512): string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    ? value
    : deny('ORDER_READ_FAILED');
}

function optionalPassthroughText(value: unknown, maximum = 512): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum ? value : null;
}

function asRecord(value: unknown): Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : deny('ORDER_READ_FAILED');
}

function canonicalUtc(value: unknown): string {
  const text = safeText(value, 64);
  const epochMs = Date.parse(text);
  if (!Number.isSafeInteger(epochMs)) deny('ORDER_READ_FAILED');
  return new Date(epochMs).toISOString();
}

function money(value: unknown): Readonly<{ value: string; currency: string }> | null {
  if (value === null || value === undefined || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.value !== 'string' || typeof record.currency !== 'string') return null;
  return Object.freeze({ value: record.value.slice(0, 32), currency: record.currency.slice(0, 8) });
}

/**
 * Extract ONLY the ceremony fields from one raw provider order. The raw body
 * is dropped immediately afterwards; buyer/contact data is read only when the
 * caller explicitly asks for the one-order shipping pass-through.
 */
function extractOrder(raw: unknown, includeShipping: boolean): FetchedEbayOrder {
  const record = asRecord(raw);
  const orderId = safeText(record.orderId, 64);
  if (!SAFE_ORDER_ID.test(orderId)) deny('ORDER_READ_FAILED');
  const lineItems = (Array.isArray(record.lineItems) ? record.lineItems : deny('ORDER_READ_FAILED'))
    .map((rawItem: unknown): PolledEbayOrderLineItem => {
      const item = asRecord(rawItem);
      const quantity = item.quantity;
      if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) {
        deny('ORDER_READ_FAILED');
      }
      return Object.freeze({
        lineItemId: safeText(item.lineItemId, 64),
        sku: typeof item.sku === 'string' && item.sku.length > 0 ? item.sku.slice(0, 128) : null,
        title: safeText(item.title, 256),
        quantity: quantity as number,
        cost: money(item.lineItemCost),
      });
    });

  let shippingPassthrough: EbayShippingPassthrough | null = null;
  if (includeShipping) {
    const instructions = Array.isArray(record.fulfillmentStartInstructions)
      ? record.fulfillmentStartInstructions
      : [];
    const shipTo = instructions.length > 0
      ? (asRecord(instructions[0]).shippingStep?.shipTo ?? null)
      : null;
    if (shipTo !== null && typeof shipTo === 'object') {
      const contact = shipTo as Record<string, any>;
      const address = contact.contactAddress !== null && typeof contact.contactAddress === 'object'
        ? contact.contactAddress as Record<string, any>
        : {};
      shippingPassthrough = Object.freeze({
        fullName: optionalPassthroughText(contact.fullName, 256),
        email: optionalPassthroughText(contact.email, 256),
        phone: optionalPassthroughText(contact.primaryPhone?.phoneNumber, 64),
        addressLine1: optionalPassthroughText(address.addressLine1, 256),
        addressLine2: optionalPassthroughText(address.addressLine2, 256),
        city: optionalPassthroughText(address.city, 128),
        stateOrProvince: optionalPassthroughText(address.stateOrProvince, 128),
        postalCode: optionalPassthroughText(address.postalCode, 32),
        countryCode: optionalPassthroughText(address.countryCode, 8),
      });
    }
  }

  return Object.freeze({
    orderId,
    creationDateUtc: canonicalUtc(record.creationDate),
    fulfillmentStatus: safeText(record.orderFulfillmentStatus ?? 'UNKNOWN', 64),
    paymentStatus: safeText(record.orderPaymentStatus ?? 'UNKNOWN', 64),
    total: money(record.pricingSummary?.total),
    lineItems: Object.freeze(lineItems),
    shippingPassthrough,
  });
}

async function boundedFetchJson(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
): Promise<Record<string, any>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      ...init,
      redirect: 'error',
      signal: controller.signal,
    });
    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      deny('ORDER_READ_FAILED');
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) deny('ORDER_READ_FAILED');
    if (!response.ok) deny('ORDER_READ_FAILED');
    return asRecord(JSON.parse(text));
  } catch (error) {
    if (error instanceof EbayOrderReadError) throw error;
    return deny('ORDER_READ_FAILED');
  } finally {
    clearTimeout(timeout);
  }
}

export function createEbayOrderReadAdapter(dependencies: Readonly<{
  fetchImpl?: FetchLike;
  getAccessToken: () => Promise<string>;
}>): EbayOrderReadAdapter {
  const fetchImpl = dependencies.fetchImpl ?? fetch;

  async function authorizedHeaders(): Promise<Record<string, string>> {
    let token = '';
    try {
      token = await dependencies.getAccessToken();
    } catch {
      deny('ORDER_READ_AUTHORITY_UNAVAILABLE');
    }
    if (typeof token !== 'string' || token.length === 0 || token.length > 4_096) {
      deny('ORDER_READ_AUTHORITY_UNAVAILABLE');
    }
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    };
  }

  return Object.freeze({
    listOrdersCreatedSince: async (
      sinceUtc: string,
      maxOrders: number,
    ): Promise<PolledEbayOrder[]> => {
      const canonicalSince = canonicalUtc(sinceUtc);
      if (!Number.isInteger(maxOrders) || maxOrders < 1 || maxOrders > MAX_PAGE_LIMIT) {
        deny('ORDER_READ_TARGET_INVALID');
      }
      const headers = await authorizedHeaders();
      const limit = Math.min(maxOrders, MAX_PAGE_LIMIT);
      const collected: PolledEbayOrder[] = [];
      const seenOrderIds = new Set<string>();
      for (let page = 0; page < MAX_LIST_PAGES && collected.length < maxOrders; page += 1) {
        const url = `${EBAY_API_HOST}/sell/fulfillment/v1/order`
          + `?filter=creationdate:%5B${canonicalSince}..%5D`
          + `&limit=${limit}&offset=${page * limit}`;
        const body = await boundedFetchJson(fetchImpl, url, { method: 'GET', headers });
        const orders = Array.isArray(body.orders) ? body.orders : [];
        for (const raw of orders) {
          if (collected.length >= maxOrders) break;
          const order = extractOrder(raw, false);
          if (seenOrderIds.has(order.orderId)) deny('ORDER_READ_FAILED');
          seenOrderIds.add(order.orderId);
          collected.push(Object.freeze({
            orderId: order.orderId,
            creationDateUtc: order.creationDateUtc,
            fulfillmentStatus: order.fulfillmentStatus,
            paymentStatus: order.paymentStatus,
            total: order.total,
            lineItems: order.lineItems,
          }));
        }
        if (orders.length < limit) break;
      }
      return collected;
    },

    getOrder: async (orderId: string): Promise<FetchedEbayOrder> => {
      if (typeof orderId !== 'string' || !SAFE_ORDER_ID.test(orderId)) {
        deny('ORDER_READ_TARGET_INVALID');
      }
      const headers = await authorizedHeaders();
      const body = await boundedFetchJson(
        fetchImpl,
        `${EBAY_API_HOST}/sell/fulfillment/v1/order/${encodeURIComponent(orderId)}`,
        { method: 'GET', headers },
      );
      const order = extractOrder(body, true);
      if (order.orderId !== orderId) deny('ORDER_READ_FAILED');
      return order;
    },
  });
}

function safeTokenText(value: unknown, maximum: number): string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    ? value
    : deny('ORDER_READ_AUTHORITY_UNAVAILABLE');
}

function safeTokenInteger(value: unknown, minimum: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum
    ? value
    : deny('ORDER_READ_AUTHORITY_UNAVAILABLE');
}

/**
 * Bounded token exchange for the order-read boundary, modeled byte-for-byte
 * on `exchangeRuntimeEbayToken` but requesting exactly the base +
 * sell.fulfillment scope pair. When the provider echoes a scope set that is
 * not exactly that pair, the exchange fails closed and no token is used.
 */
export async function exchangeOrderImportEbayToken(
  auth: RuntimeAuthMaterial,
  fetchImpl: FetchLike = fetch,
): Promise<Readonly<{ accessToken: string; expiresIn: number }>> {
  const basic = Buffer.from(`${auth.ebayAppId}:${auth.ebayCertId}`).toString('base64');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let body: Record<string, any>;
  try {
    const response = await fetchImpl('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: auth.ebayRefreshToken,
        scope: EBAY_ORDER_TOKEN_SCOPES.join(' '),
      }),
      redirect: 'error',
      signal: controller.signal,
    });
    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      deny('ORDER_READ_AUTHORITY_UNAVAILABLE');
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      deny('ORDER_READ_AUTHORITY_UNAVAILABLE');
    }
    if (!response.ok) deny('ORDER_READ_AUTHORITY_UNAVAILABLE');
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      deny('ORDER_READ_AUTHORITY_UNAVAILABLE');
    }
    body = parsed as Record<string, any>;
  } catch (error) {
    if (error instanceof EbayOrderReadError) throw error;
    return deny('ORDER_READ_AUTHORITY_UNAVAILABLE');
  } finally {
    clearTimeout(timeout);
  }
  const returnedScopes = body.scope === undefined
    ? null
    : safeTokenText(body.scope, 1024).split(/\s+/).filter(Boolean).sort();
  if (body.token_type !== 'User Access Token'
    || (returnedScopes !== null
      && JSON.stringify(returnedScopes) !== JSON.stringify([...EBAY_ORDER_TOKEN_SCOPES].sort()))) {
    deny('ORDER_READ_AUTHORITY_UNAVAILABLE');
  }
  return Object.freeze({
    accessToken: safeTokenText(body.access_token, 4096),
    expiresIn: safeTokenInteger(body.expires_in, 1),
  });
}

async function readOrderImportAuthMaterial(): Promise<RuntimeAuthMaterial> {
  const database = openShadowDatabase();
  try {
    const rows = database.prepare(
      `SELECT platform, access_token, refresh_token
       FROM auth_tokens
       WHERE platform IN ('shopify', 'ebay')`,
    ).all() as Array<{ platform: string; access_token: string; refresh_token: string | null }>;
    const shopifyAccessToken = rows.find((row) => row.platform === 'shopify')?.access_token;
    const ebayRefreshToken = rows.find((row) => row.platform === 'ebay')?.refresh_token;
    const credentials = await loadEbayCredentials();
    if (!shopifyAccessToken || !ebayRefreshToken || !credentials.appId || !credentials.certId) {
      throw new EbayOrderReadError('ORDER_READ_AUTHORITY_UNAVAILABLE');
    }
    return Object.freeze({
      shopifyAccessToken,
      ebayRefreshToken,
      ebayAppId: credentials.appId,
      ebayCertId: credentials.certId,
    });
  } finally {
    database.close();
  }
}

/**
 * Default production order-read authority: mints one transient in-memory user
 * token from the existing eBay refresh grant with exactly the base +
 * sell.fulfillment scope pair. The token is never persisted, logged, or
 * returned outside the adapter.
 */
export function createProductionOrderReadTokenProvider(): () => Promise<string> {
  return createTransientEbayTokenProvider({
    loadAuth: readOrderImportAuthMaterial,
    exchange: exchangeOrderImportEbayToken,
  });
}
