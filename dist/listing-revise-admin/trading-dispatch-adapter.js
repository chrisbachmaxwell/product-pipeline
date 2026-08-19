/**
 * Bounded eBay Trading-API write adapter for the isolated listing-revise
 * operator CLI — the goal-G5 Stage 2 extension covering legacy
 * `trading_api`-managed listings. It exposes exactly one operation,
 * `reviseFixedPriceItem`, which performs exactly one POST of one
 * `ReviseFixedPriceItem` XML request to exactly one host. The request body
 * contains only the ItemID plus elements for the manifest's changed fields;
 * because a Trading revise changes only the supplied fields, omission
 * preserves everything else — and a structural assertion guarantees the
 * serialized XML can never contain a StartPrice or Quantity element. Errors
 * are redacted to fixed codes; no token, URL, payload, or provider body is
 * ever thrown or logged.
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
const EBAY_TRADING_CALL_NAME = 'ReviseFixedPriceItem';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const EXACT_ITEM_ID = /^[0-9]{1,19}$/;
export class TradingDispatchError extends Error {
    code;
    constructor(code) {
        super('Trading listing revise dispatch adapter failed');
        this.code = code;
        this.name = 'TradingDispatchError';
    }
}
const deny = (code) => {
    throw new TradingDispatchError(code);
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
/** Same bounds as the manifest's image-list parser: 1–24 string entries. */
function parseImageList(serialized) {
    try {
        const parsed = JSON.parse(serialized);
        if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 24
            || parsed.some((entry) => typeof entry !== 'string')) {
            return deny('TRADING_DISPATCH_PAYLOAD_INVALID');
        }
        return parsed;
    }
    catch (error) {
        if (error instanceof TradingDispatchError)
            throw error;
        return deny('TRADING_DISPATCH_PAYLOAD_INVALID');
    }
}
/**
 * Serialize the one bounded ReviseFixedPriceItem request. Only the exact
 * ItemID plus one element per changed field is emitted, in a fixed order,
 * with every text value XML-escaped. Any non-Trading-dispatchable field,
 * duplicate field, or empty value fails closed, and the serialized document
 * is asserted to contain no StartPrice or Quantity element.
 */
export function buildReviseFixedPriceItemXml(input) {
    if (!EXACT_ITEM_ID.test(input.listingId))
        deny('TRADING_DISPATCH_TARGET_INVALID');
    if (input.changes.length === 0)
        deny('TRADING_DISPATCH_PAYLOAD_INVALID');
    const values = new Map();
    for (const change of input.changes) {
        if (typeof change.after !== 'string' || change.after.length === 0
            || values.has(change.field)) {
            deny('TRADING_DISPATCH_PAYLOAD_INVALID');
        }
        values.set(change.field, change.after);
    }
    const elements = [`<ItemID>${escapeXml(input.listingId)}</ItemID>`];
    const profiles = [];
    for (const [field, after] of values) {
        switch (field) {
            case 'title':
                elements.push(`<Title>${escapeXml(after)}</Title>`);
                break;
            case 'description':
                elements.push(`<Description>${escapeXml(after)}</Description>`);
                break;
            case 'condition_description':
                elements.push(`<ConditionDescription>${escapeXml(after)}</ConditionDescription>`);
                break;
            case 'images': {
                const pictureUrls = parseImageList(after)
                    .map((url) => `<PictureURL>${escapeXml(url)}</PictureURL>`);
                elements.push(`<PictureDetails>${pictureUrls.join('')}</PictureDetails>`);
                break;
            }
            case 'category':
                elements.push(`<PrimaryCategory><CategoryID>${escapeXml(after)}</CategoryID></PrimaryCategory>`);
                break;
            case 'fulfillment_policy':
                profiles.push(`<SellerShippingProfile><ShippingProfileID>${escapeXml(after)}</ShippingProfileID></SellerShippingProfile>`);
                break;
            case 'payment_policy':
                profiles.push(`<SellerPaymentProfile><PaymentProfileID>${escapeXml(after)}</PaymentProfileID></SellerPaymentProfile>`);
                break;
            case 'return_policy':
                profiles.push(`<SellerReturnProfile><ReturnProfileID>${escapeXml(after)}</ReturnProfileID></SellerReturnProfile>`);
                break;
            default:
                deny('TRADING_DISPATCH_PAYLOAD_INVALID');
        }
    }
    if (profiles.length > 0)
        elements.push(`<SellerProfiles>${profiles.join('')}</SellerProfiles>`);
    const xml = '<?xml version="1.0" encoding="utf-8"?>'
        + '<ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents">'
        + `<Item>${elements.join('')}</Item>`
        + '</ReviseFixedPriceItemRequest>';
    // Structural price/quantity preservation: a Trading revise only changes the
    // supplied fields, so the request must never carry a price or quantity
    // element under any input.
    if (/<\/?(?:StartPrice|Quantity)\b/iu.test(xml)) {
        deny('TRADING_DISPATCH_PAYLOAD_INVALID');
    }
    return xml;
}
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function createTradingDispatchAdapter(dependencies) {
    const fetchImpl = dependencies.fetchImpl ?? fetch;
    async function accessToken() {
        let token = '';
        try {
            token = await dependencies.getAccessToken();
        }
        catch {
            deny('TRADING_DISPATCH_AUTHORITY_UNAVAILABLE');
        }
        if (typeof token !== 'string' || token.length === 0 || token.length > 4_096) {
            deny('TRADING_DISPATCH_AUTHORITY_UNAVAILABLE');
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
                deny('TRADING_DISPATCH_WRITE_FAILED');
            }
            const text = await response.text();
            if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
                deny('TRADING_DISPATCH_WRITE_FAILED');
            }
            if (response.status !== 200)
                deny('TRADING_DISPATCH_WRITE_FAILED');
            return text;
        }
        catch (error) {
            if (error instanceof TradingDispatchError)
                throw error;
            return deny('TRADING_DISPATCH_WRITE_FAILED');
        }
        finally {
            clearTimeout(timeout);
        }
    }
    async function reviseFixedPriceItem(input) {
        const body = buildReviseFixedPriceItemXml(input);
        if (Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD_BYTES) {
            deny('TRADING_DISPATCH_PAYLOAD_TOO_LARGE');
        }
        const text = await boundedPost(body);
        if (/<!DOCTYPE|<!ENTITY/iu.test(text))
            deny('TRADING_DISPATCH_REJECTED');
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
            return deny('TRADING_DISPATCH_REJECTED');
        }
        const response = isRecord(parsed)
            ? parsed[`${EBAY_TRADING_CALL_NAME}Response`]
            : null;
        const ack = isRecord(response) ? response.Ack : null;
        if (ack !== 'Success' && ack !== 'Warning')
            deny('TRADING_DISPATCH_REJECTED');
    }
    return Object.freeze({ reviseFixedPriceItem });
}
