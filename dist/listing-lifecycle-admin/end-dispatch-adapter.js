/**
 * Bounded eBay write adapters for the isolated listing-lifecycle operator
 * CLI's END dispatch — one per management model:
 *
 * - Trading model: exactly one POST of one `EndFixedPriceItem` XML request to
 *   exactly one host (`https://api.ebay.com/ws/api.dll`, IAF token,
 *   compatibility level 1349, SITEID 0). The XML carries only the ItemID and
 *   the fixed EndingReason `NotAvailable`; a structural assertion guarantees
 *   it can never contain a StartPrice or Quantity element.
 * - Inventory model: exactly one POST to
 *   `/sell/inventory/v1/offer/{offerId}/withdraw`.
 *
 * Requests and responses are bounded (2 MB / 20 s), redirects are errors, and
 * errors are redacted to fixed codes; no token, URL, payload, or provider
 * body is ever thrown or logged.
 *
 * This module is intentionally not imported by the server, webhooks,
 * schedulers, or any legacy sync path. Its writes are reachable only from the
 * dispatch ceremony in `program.ts`, which requires a reserved
 * migration-store job under a live one-action approval before calling them.
 */
import { parseStringPromise } from 'xml2js';
import { createProductionDispatchTokenProvider } from '../listing-revise-admin/dispatch-adapter.js';
export { createProductionDispatchTokenProvider };
const EBAY_TRADING_URL = 'https://api.ebay.com/ws/api.dll';
const EBAY_API_HOST = 'https://api.ebay.com';
const EBAY_TRADING_COMPATIBILITY_LEVEL = '1349';
const EBAY_TRADING_SITE_ID = '0';
const EBAY_TRADING_CALL_NAME = 'EndFixedPriceItem';
const EBAY_TRADING_ENDING_REASON = 'NotAvailable';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const EXACT_ITEM_ID = /^[0-9]{1,19}$/;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export class ListingEndDispatchError extends Error {
    code;
    constructor(code) {
        super('Listing end dispatch adapter failed');
        this.code = code;
        this.name = 'ListingEndDispatchError';
    }
}
const deny = (code) => {
    throw new ListingEndDispatchError(code);
};
/** Strict XML text escaping for every serialized value: & < > " '. */
function escapeXml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
/**
 * Serialize the one bounded EndFixedPriceItem request: exactly the ItemID and
 * the fixed EndingReason, nothing else. The serialized document is asserted
 * to contain no StartPrice or Quantity element under any input.
 */
export function buildEndFixedPriceItemXml(listingId) {
    if (!EXACT_ITEM_ID.test(listingId))
        deny('END_DISPATCH_TARGET_INVALID');
    const xml = '<?xml version="1.0" encoding="utf-8"?>'
        + '<EndFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">'
        + `<ItemID>${escapeXml(listingId)}</ItemID>`
        + `<EndingReason>${EBAY_TRADING_ENDING_REASON}</EndingReason>`
        + '</EndFixedPriceItemRequest>';
    // Structural price/quantity preservation: an end request must never carry a
    // price or quantity element under any input.
    if (/<\/?(?:StartPrice|Quantity)\b/iu.test(xml)) {
        deny('END_DISPATCH_PAYLOAD_INVALID');
    }
    return xml;
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
async function requireToken(getAccessToken) {
    let token = '';
    try {
        token = await getAccessToken();
    }
    catch {
        deny('END_DISPATCH_AUTHORITY_UNAVAILABLE');
    }
    if (typeof token !== 'string' || token.length === 0 || token.length > 4_096) {
        deny('END_DISPATCH_AUTHORITY_UNAVAILABLE');
    }
    return token;
}
async function boundedText(response) {
    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        deny('END_DISPATCH_WRITE_FAILED');
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
        deny('END_DISPATCH_WRITE_FAILED');
    }
    return text;
}
export function createTradingEndDispatchAdapter(dependencies) {
    const fetchImpl = dependencies.fetchImpl ?? fetch;
    async function endFixedPriceItem(input) {
        const body = buildEndFixedPriceItemXml(input.listingId);
        if (Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD_BYTES) {
            deny('END_DISPATCH_PAYLOAD_INVALID');
        }
        const token = await requireToken(dependencies.getAccessToken);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let text = '';
        try {
            const response = await fetchImpl(EBAY_TRADING_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'text/xml',
                    'X-EBAY-API-COMPATIBILITY-LEVEL': EBAY_TRADING_COMPATIBILITY_LEVEL,
                    'X-EBAY-API-CALL-NAME': EBAY_TRADING_CALL_NAME,
                    'X-EBAY-API-SITEID': EBAY_TRADING_SITE_ID,
                    'X-EBAY-API-IAF-TOKEN': token,
                },
                body,
                redirect: 'error',
                signal: controller.signal,
            });
            text = await boundedText(response);
            if (response.status !== 200)
                deny('END_DISPATCH_WRITE_FAILED');
        }
        catch (error) {
            if (error instanceof ListingEndDispatchError)
                throw error;
            return deny('END_DISPATCH_WRITE_FAILED');
        }
        finally {
            clearTimeout(timeout);
        }
        if (/<!DOCTYPE|<!ENTITY/iu.test(text))
            deny('END_DISPATCH_REJECTED');
        let parsed;
        try {
            parsed = await parseStringPromise(text, {
                explicitArray: false,
                explicitRoot: true,
                trim: true,
                normalizeTags: false,
            });
        }
        catch {
            return deny('END_DISPATCH_REJECTED');
        }
        const response = isRecord(parsed)
            ? parsed[`${EBAY_TRADING_CALL_NAME}Response`]
            : null;
        const ack = isRecord(response) ? response.Ack : null;
        if (ack !== 'Success' && ack !== 'Warning')
            deny('END_DISPATCH_REJECTED');
    }
    return Object.freeze({ endFixedPriceItem });
}
export function createInventoryWithdrawDispatchAdapter(dependencies) {
    const fetchImpl = dependencies.fetchImpl ?? fetch;
    async function withdrawOffer(offerId) {
        if (!SAFE_SEGMENT.test(offerId))
            deny('END_DISPATCH_TARGET_INVALID');
        const token = await requireToken(dependencies.getAccessToken);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const response = await fetchImpl(`${EBAY_API_HOST}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    'Content-Language': 'en-US',
                },
                body: '{}',
                redirect: 'error',
                signal: controller.signal,
            });
            await boundedText(response);
            if (response.status !== 200 && response.status !== 204) {
                deny('END_DISPATCH_WRITE_FAILED');
            }
        }
        catch (error) {
            if (error instanceof ListingEndDispatchError)
                throw error;
            return deny('END_DISPATCH_WRITE_FAILED');
        }
        finally {
            clearTimeout(timeout);
        }
    }
    return Object.freeze({ withdrawOffer });
}
