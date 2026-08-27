/**
 * Bounded eBay Inventory-API adapter for the isolated listing-lifecycle
 * operator CLI's CREATE dispatch. It can reach exactly three resource paths
 * on exactly one host, with exactly one method each:
 *
 *   PUT  /sell/inventory/v1/inventory_item/{sku}
 *   POST /sell/inventory/v1/offer
 *   POST /sell/inventory/v1/offer/{offerId}/publish
 *
 * Every other host, path, or method is structurally impossible. Requests and
 * responses are bounded (2 MB / 20 s), redirects are errors, and errors are
 * redacted to fixed codes; no token, URL, payload, or provider body is ever
 * thrown or logged.
 *
 * This module is intentionally not imported by the server, webhooks,
 * schedulers, or any legacy sync path. Its writes are reachable only from the
 * dispatch ceremony in `program.ts`, which requires a reserved
 * migration-store job under a live one-action approval before calling them.
 */
import { createProductionDispatchTokenProvider } from '../listing-revise-admin/dispatch-adapter.js';

export { createProductionDispatchTokenProvider };

export type ListingCreateDispatchOutcomeClass = 'definite_no_effect' | 'outcome_unknown';
export type ListingCreateDispatchHttpStatusFamily =
  | 'http_1xx'
  | 'http_3xx'
  | 'http_4xx'
  | 'http_5xx';

export type ListingCreateDispatchHttpDiagnostic = Readonly<{
  statusFamily: ListingCreateDispatchHttpStatusFamily;
  statusCode: number;
  /** Present only when the bounded body matches eBay's REST errors shape. */
  ebayErrorIds: readonly number[] | null;
}>;

const EBAY_API_HOST = 'https://api.ebay.com';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_EBAY_ERROR_ENTRIES = 20;
const MAX_REPORTED_EBAY_ERROR_IDS = 5;
const MAX_EBAY_ERROR_ID = 2_147_483_647;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EXACT_LISTING_ID = /^[0-9]{1,19}$/;

export class ListingCreateDispatchError extends Error {
  constructor(readonly code:
    | 'CREATE_DISPATCH_AUTHORITY_UNAVAILABLE'
    | 'CREATE_DISPATCH_TARGET_INVALID'
    | 'CREATE_DISPATCH_PAYLOAD_TOO_LARGE'
    | 'CREATE_DISPATCH_WRITE_FAILED'
    | 'CREATE_DISPATCH_RESPONSE_INVALID',
  readonly outcomeClass: ListingCreateDispatchOutcomeClass,
  readonly httpDiagnostic: ListingCreateDispatchHttpDiagnostic | null = null) {
    super('Listing create dispatch adapter failed');
    this.name = 'ListingCreateDispatchError';
  }
}

const deny = (
  code: ConstructorParameters<typeof ListingCreateDispatchError>[0],
  outcomeClass: ListingCreateDispatchOutcomeClass,
  httpDiagnostic: ListingCreateDispatchHttpDiagnostic | null = null,
): never => {
  throw new ListingCreateDispatchError(code, outcomeClass, httpDiagnostic);
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseEbayErrorIds(text: string): readonly number[] | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.errors)) return null;
    if (parsed.errors.length === 0 || parsed.errors.length > MAX_EBAY_ERROR_ENTRIES) return null;

    const errorIds: number[] = [];
    for (const error of parsed.errors) {
      if (!isRecord(error)
        || !Number.isSafeInteger(error.errorId)
        || (error.errorId as number) < 1
        || (error.errorId as number) > MAX_EBAY_ERROR_ID) {
        return null;
      }
      errorIds.push(error.errorId as number);
    }
    return Object.freeze([...new Set(errorIds)]
      .sort((left, right) => left - right)
      .slice(0, MAX_REPORTED_EBAY_ERROR_IDS));
  } catch {
    return null;
  }
}

function httpDiagnostic(
  statusCode: number,
  text: string,
): ListingCreateDispatchHttpDiagnostic | null {
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599
    || (statusCode >= 200 && statusCode <= 299)) {
    return null;
  }
  const statusFamily: ListingCreateDispatchHttpStatusFamily = statusCode < 200
    ? 'http_1xx'
    : statusCode < 400
      ? 'http_3xx'
      : statusCode < 500
        ? 'http_4xx'
        : 'http_5xx';
  return Object.freeze({
    statusFamily,
    statusCode,
    ebayErrorIds: parseEbayErrorIds(text),
  });
}

type FetchLike = typeof fetch;

export type ListingCreateDispatchAdapter = Readonly<{
  putInventoryItem: (sku: string, payload: Record<string, unknown>) => Promise<void>;
  /** POST the offer payload; returns the provider-assigned offerId. */
  createOffer: (payload: Record<string, unknown>) => Promise<string>;
  /** POST the publish call for one exact offer; returns the new listingId. */
  publishOffer: (offerId: string) => Promise<string>;
}>;

export function createListingCreateDispatchAdapter(dependencies: Readonly<{
  fetchImpl?: FetchLike;
  getAccessToken: () => Promise<string>;
}>): ListingCreateDispatchAdapter {
  const fetchImpl = dependencies.fetchImpl ?? fetch;

  async function authorizedHeaders(): Promise<Record<string, string>> {
    let token = '';
    try {
      token = await dependencies.getAccessToken();
    } catch {
      deny('CREATE_DISPATCH_AUTHORITY_UNAVAILABLE', 'definite_no_effect');
    }
    if (typeof token !== 'string' || token.length === 0 || token.length > 4_096) {
      deny('CREATE_DISPATCH_AUTHORITY_UNAVAILABLE', 'definite_no_effect');
    }
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Content-Language': 'en-US',
      'Accept-Language': 'en-US',
    };
  }

  async function boundedRequest(
    url: string,
    init: RequestInit,
  ): Promise<{ status: number; text: string }> {
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
        deny('CREATE_DISPATCH_WRITE_FAILED', 'outcome_unknown');
      }
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
        deny('CREATE_DISPATCH_WRITE_FAILED', 'outcome_unknown');
      }
      return { status: response.status, text };
    } catch (error) {
      if (error instanceof ListingCreateDispatchError) throw error;
      return deny('CREATE_DISPATCH_WRITE_FAILED', 'outcome_unknown');
    } finally {
      clearTimeout(timeout);
    }
  }

  function boundedBody(payload: Record<string, unknown>): string {
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD_BYTES) {
      deny('CREATE_DISPATCH_PAYLOAD_TOO_LARGE', 'definite_no_effect');
    }
    return body;
  }

  function parseJsonObject(text: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return deny('CREATE_DISPATCH_RESPONSE_INVALID', 'outcome_unknown');
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ListingCreateDispatchError) throw error;
      return deny('CREATE_DISPATCH_RESPONSE_INVALID', 'outcome_unknown');
    }
  }

  async function putInventoryItem(sku: string, payload: Record<string, unknown>): Promise<void> {
    if (!SAFE_SEGMENT.test(sku)) deny('CREATE_DISPATCH_TARGET_INVALID', 'definite_no_effect');
    const body = boundedBody(payload);
    const headers = await authorizedHeaders();
    const response = await boundedRequest(
      `${EBAY_API_HOST}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
      { method: 'PUT', headers, body },
    );
    if (response.status !== 200 && response.status !== 201 && response.status !== 204) {
      const diagnostic = httpDiagnostic(response.status, response.text);
      deny(
        diagnostic === null ? 'CREATE_DISPATCH_RESPONSE_INVALID' : 'CREATE_DISPATCH_WRITE_FAILED',
        diagnostic?.statusFamily === 'http_4xx' ? 'definite_no_effect' : 'outcome_unknown',
        diagnostic,
      );
    }
  }

  async function createOffer(payload: Record<string, unknown>): Promise<string> {
    const body = boundedBody(payload);
    const headers = await authorizedHeaders();
    const response = await boundedRequest(
      `${EBAY_API_HOST}/sell/inventory/v1/offer`,
      { method: 'POST', headers, body },
    );
    if (response.status !== 200 && response.status !== 201) {
      const diagnostic = httpDiagnostic(response.status, response.text);
      deny(
        diagnostic === null ? 'CREATE_DISPATCH_RESPONSE_INVALID' : 'CREATE_DISPATCH_WRITE_FAILED',
        'outcome_unknown',
        diagnostic,
      );
    }
    const parsed = parseJsonObject(response.text);
    const offerId = parsed.offerId;
    if (typeof offerId !== 'string' || !SAFE_SEGMENT.test(offerId)) {
      return deny('CREATE_DISPATCH_RESPONSE_INVALID', 'outcome_unknown');
    }
    return offerId;
  }

  async function publishOffer(offerId: string): Promise<string> {
    if (!SAFE_SEGMENT.test(offerId)) {
      deny('CREATE_DISPATCH_TARGET_INVALID', 'definite_no_effect');
    }
    const headers = await authorizedHeaders();
    const response = await boundedRequest(
      `${EBAY_API_HOST}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`,
      { method: 'POST', headers, body: '{}' },
    );
    if (response.status !== 200) {
      const diagnostic = httpDiagnostic(response.status, response.text);
      deny(
        diagnostic === null ? 'CREATE_DISPATCH_RESPONSE_INVALID' : 'CREATE_DISPATCH_WRITE_FAILED',
        'outcome_unknown',
        diagnostic,
      );
    }
    const parsed = parseJsonObject(response.text);
    const listingId = parsed.listingId;
    if (typeof listingId !== 'string' || !EXACT_LISTING_ID.test(listingId)) {
      return deny('CREATE_DISPATCH_RESPONSE_INVALID', 'outcome_unknown');
    }
    return listingId;
  }

  return Object.freeze({ putInventoryItem, createOffer, publishOffer });
}
