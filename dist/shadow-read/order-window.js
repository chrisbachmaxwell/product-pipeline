import { denyShadowRead } from './errors.js';
export const MAX_ORDER_READ_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const WINDOW_KEYS = ['creationDateEndUtc', 'creationDateStartUtc'];
const VALIDATED_WINDOWS = new WeakSet();
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, expected) {
    const actual = Object.keys(value).sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function canonicalUtc(value) {
    if (typeof value !== 'string')
        return null;
    const parsed = Date.parse(value);
    return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}
/**
 * Creates a read observation window, never a cutover watermark. Both explicit
 * creationDate bounds are mandatory and the end cannot be in the future.
 */
export function validateBoundedOrderReadWindow(rawWindow, nowUtc) {
    if (!isRecord(rawWindow) || !hasExactKeys(rawWindow, WINDOW_KEYS)) {
        denyShadowRead('order-window-denied');
    }
    const nowMs = canonicalUtc(nowUtc);
    const startMs = canonicalUtc(rawWindow.creationDateStartUtc);
    const endMs = canonicalUtc(rawWindow.creationDateEndUtc);
    if (nowMs === null
        || startMs === null
        || endMs === null
        || startMs >= endMs
        || endMs > nowMs
        || endMs - startMs > MAX_ORDER_READ_WINDOW_MS) {
        denyShadowRead('order-window-denied');
    }
    const window = Object.freeze({
        kind: 'bounded-order-observation-window',
        eventTimeField: 'creationDate',
        lowerBoundInclusiveUtc: rawWindow.creationDateStartUtc,
        upperBoundExclusiveUtc: rawWindow.creationDateEndUtc,
        durationMs: endMs - startMs,
        notCutoverWatermark: true,
        historicalBackfillAuthorized: false,
        fixtureBoundarySemantics: 'normalized-half-open',
        liveEbayBoundarySemanticsVerified: false,
    });
    VALIDATED_WINDOWS.add(window);
    return window;
}
/** Internal transport seam: forged/plain objects cannot supply order bounds. */
export function orderWindowQueryForTransport(window, source) {
    if (!window || typeof window !== 'object' || !VALIDATED_WINDOWS.has(window)) {
        denyShadowRead('order-window-denied');
    }
    if (source !== 'shopify' && source !== 'ebay')
        denyShadowRead('order-window-denied');
    if (source === 'shopify') {
        return Object.freeze({
            created_at_min: window.lowerBoundInclusiveUtc,
            created_at_max: window.upperBoundExclusiveUtc,
        });
    }
    // Fixture rendering only. The normalized contract is half-open, but this
    // bracket representation is not evidence of live eBay upper-bound semantics.
    return Object.freeze({
        filter: `creationdate:[${window.lowerBoundInclusiveUtc}..${window.upperBoundExclusiveUtc}]`,
    });
}
