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
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const EXACT_ITEM_ID = /^[0-9]{1,19}$/;
const PRICE_AMOUNT = /^[0-9]{1,10}(\.[0-9]{1,2})?$/;
const CURRENCY = /^[A-Z]{3}$/;
export class TradingAlignDispatchError extends Error {
    code;
    constructor(code) {
        super('Trading price/inventory alignment dispatch adapter failed');
        this.code = code;
        this.name = 'TradingAlignDispatchError';
    }
}
const deny = (code) => {
    throw new TradingAlignDispatchError(code);
};
/**
 * Serialize the one bounded ReviseInventoryStatus request: exactly one
 * InventoryStatus element with the exact ItemID plus exactly one aligned
 * element. Every serialized value is validated against a strict safe
 * grammar (numeric item id, decimal amount, ISO currency, safe integer), so
 * no XML escaping surface exists; the price/quantity cross-contamination
 * assertion runs on the final serialized document.
 */
export function buildReviseInventoryStatusXml(input) {
    if (!EXACT_ITEM_ID.test(input.listingId))
        deny('TRADING_ALIGN_TARGET_INVALID');
    let alignedElement;
    if (input.field === 'price') {
        const { price } = input;
        if (!price || typeof price.value !== 'string' || !PRICE_AMOUNT.test(price.value)
            || Number(price.value) <= 0 || typeof price.currency !== 'string'
            || !CURRENCY.test(price.currency)) {
            deny('TRADING_ALIGN_PAYLOAD_INVALID');
        }
        alignedElement = `<StartPrice currencyID="${price.currency}">${price.value}</StartPrice>`;
    }
    else if (input.field === 'quantity') {
        if (!Number.isSafeInteger(input.quantity) || input.quantity < 0) {
            deny('TRADING_ALIGN_PAYLOAD_INVALID');
        }
        alignedElement = `<Quantity>${String(input.quantity)}</Quantity>`;
    }
    else {
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
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function createTradingAlignDispatchAdapter(dependencies) {
    const fetchImpl = dependencies.fetchImpl ?? fetch;
    async function accessToken() {
        let token = '';
        try {
            token = await dependencies.getAccessToken();
        }
        catch {
            deny('TRADING_ALIGN_AUTHORITY_UNAVAILABLE');
        }
        if (typeof token !== 'string' || token.length === 0 || token.length > 4_096) {
            deny('TRADING_ALIGN_AUTHORITY_UNAVAILABLE');
        }
        return token;
    }
    async function boundedPost(body) {
        const token = await accessToken();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
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
            const declaredLength = Number(response.headers.get('content-length') ?? '0');
            if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
                deny('TRADING_ALIGN_WRITE_FAILED');
            }
            const text = await response.text();
            if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
                deny('TRADING_ALIGN_WRITE_FAILED');
            }
            if (response.status !== 200)
                deny('TRADING_ALIGN_WRITE_FAILED');
            return text;
        }
        catch (error) {
            if (error instanceof TradingAlignDispatchError)
                throw error;
            return deny('TRADING_ALIGN_WRITE_FAILED');
        }
        finally {
            clearTimeout(timeout);
        }
    }
    async function reviseInventoryStatus(input) {
        const body = buildReviseInventoryStatusXml(input);
        if (Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD_BYTES) {
            deny('TRADING_ALIGN_PAYLOAD_TOO_LARGE');
        }
        const text = await boundedPost(body);
        if (/<!DOCTYPE|<!ENTITY/iu.test(text))
            deny('TRADING_ALIGN_REJECTED');
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
            return deny('TRADING_ALIGN_REJECTED');
        }
        const response = isRecord(parsed)
            ? parsed[`${EBAY_TRADING_CALL_NAME}Response`]
            : null;
        const ack = isRecord(response) ? response.Ack : null;
        if (ack !== 'Success' && ack !== 'Warning')
            deny('TRADING_ALIGN_REJECTED');
    }
    return Object.freeze({ reviseInventoryStatus });
}
