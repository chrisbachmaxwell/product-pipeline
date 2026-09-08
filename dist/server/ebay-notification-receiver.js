import { createHash, timingSafeEqual } from 'node:crypto';
/**
 * Verification and classification for eBay Platform Notifications.
 *
 * A notification is untrusted caller-controlled XML until its
 * NotificationSignature verifies: Base64(MD5(timestamp + devId + appId +
 * certId)) over the exact Timestamp string in the SOAP header, per the eBay
 * Platform Notifications specification. The payload is deliberately examined
 * with bounded pattern extraction, never a general XML parse: nothing here
 * builds a document tree from unverified input, and nothing beyond the
 * timestamp, signature, event name, and item id is read at all.
 *
 * The receiver is READ-ONLY by construction. A verified sale/close/revise
 * event triggers the same catalog refresh and belief-gated alignment sweep
 * the Shopify webhook already triggers -- machinery the operator has already
 * armed -- and nothing else. No order is imported here: order import stays
 * with the incumbent until its own ceremony-gated cutover.
 */
const TIMESTAMP_PATTERN = /<(?:[A-Za-z0-9]+:)?Timestamp>([0-9T:.Z-]{20,35})<\/(?:[A-Za-z0-9]+:)?Timestamp>/u;
const SIGNATURE_PATTERN = /<(?:[A-Za-z0-9]+:)?NotificationSignature[^>]*>([A-Za-z0-9+/=]{16,64})<\/(?:[A-Za-z0-9]+:)?NotificationSignature>/u;
const EVENT_PATTERN = /<(?:[A-Za-z0-9]+:)?NotificationEventName>([A-Za-z]{3,64})<\/(?:[A-Za-z0-9]+:)?NotificationEventName>/u;
const ITEM_ID_PATTERN = /<(?:[A-Za-z0-9]+:)?ItemID>([0-9]{6,20})<\/(?:[A-Za-z0-9]+:)?ItemID>/u;
/** Reject notifications whose timestamp is farther than this from now. */
const MAX_CLOCK_SKEW_MS = 10 * 60_000;
/** Larger bodies are dropped unread; real notifications are a few KB. */
export const MAX_NOTIFICATION_BYTES = 512 * 1024;
/**
 * Events that can change what is listed or available on eBay, and therefore
 * warrant a catalog refresh plus an alignment sweep. Everything else verified
 * is logged and ignored.
 */
const ALIGNMENT_EVENTS = Object.freeze([
    'FixedPriceTransaction',
    'AuctionCheckoutComplete',
    'ItemSold',
    'ItemClosed',
    'ItemRevised',
    'ItemListed',
    'ItemUnsold',
]);
export function verifyEbayNotification(input) {
    const reject = (reason) => Object.freeze({
        outcome: 'rejected', reason, eventName: null, itemId: null,
        alignmentRelevant: false,
    });
    if (typeof input.body !== 'string' || input.body.length === 0
        || Buffer.byteLength(input.body, 'utf8') > MAX_NOTIFICATION_BYTES) {
        return reject('body_invalid');
    }
    if (input.credentials === null)
        return reject('credentials_unavailable');
    const timestamp = TIMESTAMP_PATTERN.exec(input.body)?.[1];
    if (!timestamp)
        return reject('timestamp_missing');
    const parsed = Date.parse(timestamp);
    if (!Number.isFinite(parsed) || Math.abs(input.nowMs - parsed) > MAX_CLOCK_SKEW_MS) {
        return reject('timestamp_stale');
    }
    const suppliedSignature = SIGNATURE_PATTERN.exec(input.body)?.[1];
    if (!suppliedSignature)
        return reject('signature_missing');
    const { devId, appId, certId } = input.credentials;
    const expected = createHash('md5')
        .update(timestamp + devId + appId + certId, 'utf8')
        .digest('base64');
    const suppliedBuffer = Buffer.from(suppliedSignature, 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    if (suppliedBuffer.length !== expectedBuffer.length
        || !timingSafeEqual(suppliedBuffer, expectedBuffer)) {
        return reject('signature_mismatch');
    }
    const eventName = EVENT_PATTERN.exec(input.body)?.[1] ?? null;
    const itemId = ITEM_ID_PATTERN.exec(input.body)?.[1] ?? null;
    return Object.freeze({
        outcome: 'verified',
        reason: 'ok',
        eventName,
        itemId,
        alignmentRelevant: eventName !== null && ALIGNMENT_EVENTS.includes(eventName),
    });
}
