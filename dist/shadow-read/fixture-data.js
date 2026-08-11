import { createHash } from 'node:crypto';
import { denyShadowRead } from './errors.js';
const FORBIDDEN_KEY = /(?:authorization|cookie|access[_-]?token|refresh[_-]?token|token|secret|password|credential|api[_-]?key|email|phone|address|customer|buyer|first[_-]?name|last[_-]?name|full[_-]?name)/i;
const FORBIDDEN_VALUE = /^(?:Bearer\s+|shpat_|shpca_|shppa_|gh[pousr]_|sk-[A-Za-z0-9_-]{10,}|v\^1\.)/i;
const EMAIL_VALUE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NODES = 100_000;
const MAX_DEPTH = 32;
const MAX_KEY_LENGTH = 256;
const MAX_STRING_LENGTH = 1_000_000;
function canonicalClone(value, seen, state, depth) {
    state.nodes += 1;
    if (state.nodes > MAX_NODES || depth > MAX_DEPTH)
        denyShadowRead('fixture-payload-denied');
    if (value === null || typeof value === 'boolean')
        return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value))
            denyShadowRead('fixture-payload-denied');
        return value;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (value.length > MAX_STRING_LENGTH
            || FORBIDDEN_VALUE.test(trimmed)
            || EMAIL_VALUE.test(trimmed)) {
            denyShadowRead('fixture-payload-denied');
        }
        return value;
    }
    if (typeof value !== 'object' || value === undefined) {
        denyShadowRead('fixture-payload-denied');
    }
    if (seen.has(value))
        denyShadowRead('fixture-payload-denied');
    seen.add(value);
    if (Array.isArray(value)) {
        return Object.freeze(value.map((entry) => canonicalClone(entry, seen, state, depth + 1)));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        denyShadowRead('fixture-payload-denied');
    }
    const result = {};
    for (const key of Object.keys(value).sort()) {
        if (key.length < 1 || key.length > MAX_KEY_LENGTH || FORBIDDEN_KEY.test(key)) {
            denyShadowRead('fixture-payload-denied');
        }
        result[key] = canonicalClone(value[key], seen, state, depth + 1);
    }
    return Object.freeze(result);
}
/**
 * Produces an immutable, canonical, secret/PII-denied fixture dataset and
 * computes count, bytes, and digest locally rather than trusting a dispatcher.
 */
export function sanitizeFixtureRecords(rawRecords, maxRecords, maxBytes) {
    if (!Array.isArray(rawRecords))
        denyShadowRead('fixture-payload-denied');
    if (rawRecords.length > maxRecords)
        denyShadowRead('record-cap-exceeded');
    const cloned = canonicalClone(rawRecords, new WeakSet(), { nodes: 0 }, 0);
    if (!Array.isArray(cloned))
        denyShadowRead('fixture-payload-denied');
    const canonical = JSON.stringify(cloned);
    const responseBytes = Buffer.byteLength(canonical, 'utf8');
    if (responseBytes > maxBytes)
        denyShadowRead('response-byte-cap-exceeded');
    const datasetDigest = `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
    return Object.freeze({
        records: cloned,
        recordCount: cloned.length,
        responseBytes,
        datasetDigest,
    });
}
