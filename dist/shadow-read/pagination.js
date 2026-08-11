import { createHash } from 'node:crypto';
import { denyShadowRead } from './errors.js';
import { sanitizeFixtureRecords } from './fixture-data.js';
import { HARD_READ_LIMITS } from './limits.js';
const CURSOR_PAGE_KEYS = [
    'nextCursor',
    'pageComplete',
    'records',
    'reportedTotal',
    'requestCursor',
];
const OFFSET_PAGE_KEYS = ['limit', 'offset', 'pageComplete', 'records', 'reportedTotal'];
const OPTION_KEYS = ['caps', 'expectedTotal', 'stableId'];
const CAP_KEYS = ['maxPages', 'maxRecords'];
const MAX_CURSOR_LENGTH = 2_048;
const MAX_STABLE_ID_LENGTH = 512;
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, expected) {
    const actual = Object.keys(value).sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function validateOptions(raw) {
    if (!isRecord(raw) || !hasExactKeys(raw, OPTION_KEYS) || !isRecord(raw.caps)) {
        denyShadowRead('pagination-denied');
    }
    if (!hasExactKeys(raw.caps, CAP_KEYS))
        denyShadowRead('pagination-denied');
    const maxPages = raw.caps.maxPages;
    const maxRecords = raw.caps.maxRecords;
    const expectedTotal = raw.expectedTotal;
    if (!Number.isInteger(maxPages)
        || Number(maxPages) < 1
        || Number(maxPages) > HARD_READ_LIMITS.maxPages
        || !Number.isInteger(maxRecords)
        || Number(maxRecords) < 1
        || Number(maxRecords) > HARD_READ_LIMITS.maxRecords
        || (expectedTotal !== null && (!Number.isInteger(expectedTotal) || Number(expectedTotal) < 0))
        || typeof raw.stableId !== 'function') {
        denyShadowRead('pagination-denied');
    }
    return raw;
}
function validCursor(value) {
    return value === null || (typeof value === 'string'
        && value.length >= 1
        && value.length <= MAX_CURSOR_LENGTH
        && !/[\u0000-\u001f\u007f\s]/.test(value));
}
function stableIdFor(record, selector) {
    let id;
    try {
        id = selector(record);
    }
    catch {
        denyShadowRead('pagination-denied');
    }
    if (typeof id !== 'string'
        || id.length < 1
        || id.length > MAX_STABLE_ID_LENGTH
        || /[\u0000-\u001f\u007f]/.test(id)) {
        denyShadowRead('pagination-denied');
    }
    return id;
}
function appendUniqueRecords(target, records, ids, options) {
    if (target.length + records.length > options.caps.maxRecords) {
        denyShadowRead('record-cap-exceeded');
    }
    for (const record of records) {
        const id = stableIdFor(record, options.stableId);
        if (ids.has(id))
            denyShadowRead('pagination-denied');
        ids.add(id);
        target.push(record);
    }
}
function terminalDigest(cursor) {
    return `sha256:${createHash('sha256').update(JSON.stringify(cursor)).digest('hex')}`;
}
function validateFinalTotal(recordCount, reportedTotal, expectedTotal) {
    if (reportedTotal !== null && reportedTotal !== recordCount) {
        denyShadowRead('pagination-denied');
    }
    if (expectedTotal !== null && expectedTotal !== recordCount) {
        denyShadowRead('pagination-denied');
    }
    if (reportedTotal !== null && expectedTotal !== null && reportedTotal !== expectedTotal) {
        denyShadowRead('pagination-denied');
    }
}
/**
 * Validates already collected cursor pages. It performs no requests and emits a
 * `complete: true` proof only after terminal-cursor, count, and identity checks.
 */
export function collectCompleteCursorPages(rawPages, rawOptions) {
    const options = validateOptions(rawOptions);
    if (!Array.isArray(rawPages) || rawPages.length === 0)
        denyShadowRead('pagination-denied');
    if (rawPages.length > options.caps.maxPages)
        denyShadowRead('page-cap-exceeded');
    const records = [];
    const stableIds = new Set();
    const requestedCursors = new Set();
    let expectedRequestCursor = null;
    let reportedTotal = null;
    let terminalRequestCursor = null;
    rawPages.forEach((rawPage, index) => {
        if (!isRecord(rawPage) || !hasExactKeys(rawPage, CURSOR_PAGE_KEYS)) {
            denyShadowRead('pagination-denied');
        }
        const page = rawPage;
        if (!validCursor(page.requestCursor)
            || !validCursor(page.nextCursor)
            || page.requestCursor !== expectedRequestCursor
            || page.pageComplete !== true
            || !Array.isArray(page.records)
            || (page.reportedTotal !== null
                && (!Number.isInteger(page.reportedTotal) || page.reportedTotal < 0))) {
            denyShadowRead('pagination-denied');
        }
        if (page.requestCursor !== null) {
            if (requestedCursors.has(page.requestCursor))
                denyShadowRead('pagination-denied');
            requestedCursors.add(page.requestCursor);
        }
        if (page.nextCursor !== null && requestedCursors.has(page.nextCursor)) {
            denyShadowRead('pagination-denied');
        }
        const terminalPage = index === rawPages.length - 1;
        if ((!terminalPage && page.nextCursor === null) || (terminalPage && page.nextCursor !== null)) {
            denyShadowRead('pagination-denied');
        }
        if (!terminalPage && page.records.length === 0)
            denyShadowRead('pagination-denied');
        if (page.reportedTotal !== null) {
            if (reportedTotal !== null && reportedTotal !== page.reportedTotal) {
                denyShadowRead('pagination-denied');
            }
            reportedTotal = page.reportedTotal;
        }
        appendUniqueRecords(records, page.records, stableIds, options);
        terminalRequestCursor = page.requestCursor;
        expectedRequestCursor = page.nextCursor;
    });
    validateFinalTotal(records.length, reportedTotal, options.expectedTotal);
    const sanitized = sanitizeFixtureRecords(records, options.caps.maxRecords, HARD_READ_LIMITS.maxResponseBytes);
    return Object.freeze({
        complete: true,
        records: sanitized.records,
        pageCount: rawPages.length,
        recordCount: records.length,
        reportedTotal,
        terminalCursorDigest: terminalDigest(terminalRequestCursor),
        datasetDigest: sanitized.datasetDigest,
        fixtureOnly: true,
        liveProof: false,
    });
}
/**
 * Validates already collected offset pages. It requires a consistent source
 * total and contiguous, full non-terminal pages before emitting completeness.
 */
export function collectCompleteOffsetPages(rawPages, rawOptions) {
    const options = validateOptions(rawOptions);
    if (!Array.isArray(rawPages) || rawPages.length === 0)
        denyShadowRead('pagination-denied');
    if (rawPages.length > options.caps.maxPages)
        denyShadowRead('page-cap-exceeded');
    const records = [];
    const stableIds = new Set();
    let expectedOffset = 0;
    let reportedTotal = null;
    rawPages.forEach((rawPage, index) => {
        if (!isRecord(rawPage) || !hasExactKeys(rawPage, OFFSET_PAGE_KEYS)) {
            denyShadowRead('pagination-denied');
        }
        const page = rawPage;
        if (!Number.isInteger(page.offset)
            || page.offset !== expectedOffset
            || !Number.isInteger(page.limit)
            || page.limit < 1
            || page.limit > options.caps.maxRecords
            || page.pageComplete !== true
            || !Array.isArray(page.records)
            || page.records.length > page.limit
            || !Number.isInteger(page.reportedTotal)
            || page.reportedTotal < 0) {
            denyShadowRead('pagination-denied');
        }
        const terminalPage = index === rawPages.length - 1;
        if (!terminalPage && page.records.length !== page.limit) {
            denyShadowRead('pagination-denied');
        }
        if (reportedTotal !== null && reportedTotal !== page.reportedTotal) {
            denyShadowRead('pagination-denied');
        }
        reportedTotal = page.reportedTotal;
        appendUniqueRecords(records, page.records, stableIds, options);
        expectedOffset = page.offset + page.records.length;
    });
    validateFinalTotal(records.length, reportedTotal, options.expectedTotal);
    const sanitized = sanitizeFixtureRecords(records, options.caps.maxRecords, HARD_READ_LIMITS.maxResponseBytes);
    return Object.freeze({
        complete: true,
        records: sanitized.records,
        pageCount: rawPages.length,
        recordCount: records.length,
        reportedTotal,
        terminalCursorDigest: null,
        datasetDigest: sanitized.datasetDigest,
        fixtureOnly: true,
        liveProof: false,
    });
}
