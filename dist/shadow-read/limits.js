import { denyShadowRead } from './errors.js';
export const HARD_READ_LIMITS = Object.freeze({
    timeoutMs: 15_000,
    maxPages: 100,
    maxRecords: 10_000,
    maxResponseBytes: 5 * 1024 * 1024,
});
const LIMIT_KEYS = ['maxPages', 'maxRecords', 'maxResponseBytes', 'timeoutMs'];
function boundedInteger(value, maximum) {
    return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= maximum;
}
export function validateReadLimits(input) {
    if (!input
        || typeof input !== 'object'
        || Array.isArray(input)
        || Object.keys(input).sort().some((key, index) => key !== LIMIT_KEYS[index])
        || Object.keys(input).length !== LIMIT_KEYS.length) {
        denyShadowRead('configuration-denied');
    }
    const candidate = input;
    if (!boundedInteger(candidate.timeoutMs, HARD_READ_LIMITS.timeoutMs)
        || !boundedInteger(candidate.maxPages, HARD_READ_LIMITS.maxPages)
        || !boundedInteger(candidate.maxRecords, HARD_READ_LIMITS.maxRecords)
        || !boundedInteger(candidate.maxResponseBytes, HARD_READ_LIMITS.maxResponseBytes)) {
        denyShadowRead('configuration-denied');
    }
    return Object.freeze({
        timeoutMs: candidate.timeoutMs,
        maxPages: candidate.maxPages,
        maxRecords: candidate.maxRecords,
        maxResponseBytes: candidate.maxResponseBytes,
    });
}
