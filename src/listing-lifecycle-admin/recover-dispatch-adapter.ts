/**
 * Bounded eBay Inventory-API adapter for the isolated listing-lifecycle
 * operator CLI's RECOVER-CREATE cleanup dispatch. It can reach exactly two
 * resource paths on exactly one host, with exactly two methods each:
 *
 *   GET    /sell/inventory/v1/offer/{offerId}
 *   DELETE /sell/inventory/v1/offer/{offerId}
 *   GET    /sell/inventory/v1/inventory_item/{sku}
 *   DELETE /sell/inventory/v1/inventory_item/{sku}
 *
 * Every other host, path, or method is structurally impossible — in
 * particular no publish, create, or revise call exists here, so this adapter
 * can never finish, replay, or alter a listing; it can only observe and
 * remove the exact named residue. Requests and responses are bounded
 * (2 MB / 20 s), redirects are errors, and errors are redacted to fixed
 * codes; no token, URL, payload, or provider body is ever thrown or logged.
 *
 * This module is intentionally not imported by the server, webhooks,
 * schedulers, or any legacy sync path. Its writes are reachable only from the
 * recover-create ceremony in `program.ts`, which requires a reserved
 * migration-store job under a live one-action approval before calling them.
 */
import { createProductionDispatchTokenProvider } from '../listing-revise-admin/dispatch-adapter.js';

export { createProductionDispatchTokenProvider };

export type ListingRecoverDispatchOutcomeClass = 'definite_no_effect' | 'outcome_unknown';

const EBAY_API_HOST = 'https://api.ebay.com';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OFFER_STATUSES = ['PUBLISHED', 'UNPUBLISHED'] as const;
export type RecoveredOfferStatus = (typeof OFFER_STATUSES)[number];

export class ListingRecoverDispatchError extends Error {
  constructor(readonly code:
    | 'RECOVER_DISPATCH_AUTHORITY_UNAVAILABLE'
    | 'RECOVER_DISPATCH_TARGET_INVALID'
    | 'RECOVER_DISPATCH_READ_FAILED'
    | 'RECOVER_DISPATCH_WRITE_FAILED'
    | 'RECOVER_DISPATCH_RESPONSE_INVALID',
  readonly outcomeClass: ListingRecoverDispatchOutcomeClass) {
    super('Listing recover dispatch adapter failed');
    this.name = 'ListingRecoverDispatchError';
  }
}

const deny = (
  code: ConstructorParameters<typeof ListingRecoverDispatchError>[0],
  outcomeClass: ListingRecoverDispatchOutcomeClass,
): never => {
  throw new ListingRecoverDispatchError(code, outcomeClass);
};

type FetchLike = typeof fetch;

export type RecoveredOfferState = Readonly<{
  found: boolean;
  /** Present only when found. */
  sku: string | null;
  status: RecoveredOfferStatus | null;
}>;

export type RecoveredInventoryItemState = Readonly<{
  found: boolean;
  /** Present only when found. */
  sku: string | null;
}>;

export type ListingRecoverDispatchAdapter = Readonly<{
  /** GET the one exact offer; 404 reports found: false. */
  getOffer: (offerId: string) => Promise<RecoveredOfferState>;
  /** DELETE the one exact offer; only 204 is success. */
  deleteOffer: (offerId: string) => Promise<void>;
  /** GET the one exact inventory item; 404 reports found: false. */
  getInventoryItem: (sku: string) => Promise<RecoveredInventoryItemState>;
  /** DELETE the one exact inventory item; only 204 is success. */
  deleteInventoryItem: (sku: string) => Promise<void>;
}>;

export function createListingRecoverDispatchAdapter(dependencies: Readonly<{
  fetchImpl?: FetchLike;
  getAccessToken: () => Promise<string>;
}>): ListingRecoverDispatchAdapter {
  const fetchImpl = dependencies.fetchImpl ?? fetch;

  async function authorizedHeaders(): Promise<Record<string, string>> {
    let token = '';
    try {
      token = await dependencies.getAccessToken();
    } catch {
      deny('RECOVER_DISPATCH_AUTHORITY_UNAVAILABLE', 'definite_no_effect');
    }
    if (typeof token !== 'string' || token.length === 0 || token.length > 4_096) {
      deny('RECOVER_DISPATCH_AUTHORITY_UNAVAILABLE', 'definite_no_effect');
    }
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Accept-Language': 'en-US',
    };
  }

  async function boundedRequest(
    url: string,
    init: RequestInit,
    failureCode: 'RECOVER_DISPATCH_READ_FAILED' | 'RECOVER_DISPATCH_WRITE_FAILED',
    failureOutcome: ListingRecoverDispatchOutcomeClass,
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
        deny(failureCode, failureOutcome);
      }
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
        deny(failureCode, failureOutcome);
      }
      return { status: response.status, text };
    } catch (error) {
      if (error instanceof ListingRecoverDispatchError) throw error;
      return deny(failureCode, failureOutcome);
    } finally {
      clearTimeout(timeout);
    }
  }

  function parseJsonObject(text: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return deny('RECOVER_DISPATCH_RESPONSE_INVALID', 'outcome_unknown');
      }
      return parsed as Record<string, unknown>;
    } catch (error) {
      if (error instanceof ListingRecoverDispatchError) throw error;
      return deny('RECOVER_DISPATCH_RESPONSE_INVALID', 'outcome_unknown');
    }
  }

  async function getOffer(offerId: string): Promise<RecoveredOfferState> {
    if (!SAFE_SEGMENT.test(offerId)) {
      deny('RECOVER_DISPATCH_TARGET_INVALID', 'definite_no_effect');
    }
    const headers = await authorizedHeaders();
    const response = await boundedRequest(
      `${EBAY_API_HOST}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
      { method: 'GET', headers },
      'RECOVER_DISPATCH_READ_FAILED',
      'definite_no_effect',
    );
    if (response.status === 404) {
      return Object.freeze({ found: false, sku: null, status: null });
    }
    if (response.status !== 200) {
      deny('RECOVER_DISPATCH_READ_FAILED', 'definite_no_effect');
    }
    const parsed = parseJsonObject(response.text);
    const sku = parsed.sku;
    const status = parsed.status;
    if (typeof sku !== 'string' || !SAFE_SEGMENT.test(sku)
      || typeof status !== 'string'
      || !OFFER_STATUSES.includes(status as RecoveredOfferStatus)
      || (typeof parsed.offerId === 'string' && parsed.offerId !== offerId)) {
      return deny('RECOVER_DISPATCH_RESPONSE_INVALID', 'definite_no_effect');
    }
    return Object.freeze({ found: true, sku, status: status as RecoveredOfferStatus });
  }

  async function deleteOffer(offerId: string): Promise<void> {
    if (!SAFE_SEGMENT.test(offerId)) {
      deny('RECOVER_DISPATCH_TARGET_INVALID', 'definite_no_effect');
    }
    const headers = await authorizedHeaders();
    const response = await boundedRequest(
      `${EBAY_API_HOST}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
      { method: 'DELETE', headers },
      'RECOVER_DISPATCH_WRITE_FAILED',
      'outcome_unknown',
    );
    if (response.status !== 204) {
      deny('RECOVER_DISPATCH_WRITE_FAILED', 'outcome_unknown');
    }
  }

  async function getInventoryItem(sku: string): Promise<RecoveredInventoryItemState> {
    if (!SAFE_SEGMENT.test(sku)) {
      deny('RECOVER_DISPATCH_TARGET_INVALID', 'definite_no_effect');
    }
    const headers = await authorizedHeaders();
    const response = await boundedRequest(
      `${EBAY_API_HOST}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
      { method: 'GET', headers },
      'RECOVER_DISPATCH_READ_FAILED',
      'definite_no_effect',
    );
    if (response.status === 404) {
      return Object.freeze({ found: false, sku: null });
    }
    if (response.status !== 200) {
      deny('RECOVER_DISPATCH_READ_FAILED', 'definite_no_effect');
    }
    const parsed = parseJsonObject(response.text);
    const parsedSku = parsed.sku;
    if (typeof parsedSku !== 'string' || !SAFE_SEGMENT.test(parsedSku)) {
      return deny('RECOVER_DISPATCH_RESPONSE_INVALID', 'definite_no_effect');
    }
    return Object.freeze({ found: true, sku: parsedSku });
  }

  async function deleteInventoryItem(sku: string): Promise<void> {
    if (!SAFE_SEGMENT.test(sku)) {
      deny('RECOVER_DISPATCH_TARGET_INVALID', 'definite_no_effect');
    }
    const headers = await authorizedHeaders();
    const response = await boundedRequest(
      `${EBAY_API_HOST}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`,
      { method: 'DELETE', headers },
      'RECOVER_DISPATCH_WRITE_FAILED',
      'outcome_unknown',
    );
    if (response.status !== 204) {
      deny('RECOVER_DISPATCH_WRITE_FAILED', 'outcome_unknown');
    }
  }

  return Object.freeze({ getOffer, deleteOffer, getInventoryItem, deleteInventoryItem });
}
