/**
 * L76: the watchdog's detection logic — the alarm surface L75 proved was
 * missing. Pure-function tests over the emergency shapes plus the runner's
 * persistence rule and diagnosis/escalation wiring, all with injected
 * dependencies (no network, no filesystem outside a temp state file).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateIncidentCandidates, getIncidents, publishBlockCandidates, runWatchdogOnce, } from './incident-watchdog.js';
import { OPERATOR_DATA_SKIP_REASONS } from './publish-all.js';
const NOW = Date.parse('2026-09-25T20:00:00.000Z');
const FRESH = new Date(NOW - 60_000).toISOString();
function row(sku, available, listingId) {
    return {
        shopify: { sku, title: sku, available, productStatus: 'ACTIVE' },
        ebay: { listingId },
    };
}
describe('evaluateIncidentCandidates', () => {
    it('flags a zero-stock item whose eBay listing is still live as critical', () => {
        const candidates = evaluateIncidentCandidates({
            snapshot: { observedAtUtc: FRESH, rows: [row('LEICA-1', 0, '147000000001')] },
            signals: { oldestUnresolvedOrder: null, unresolvedCreates: [], unresolvedFulfillments: [], repeatedEndFailures: [], repeatedPriceFailures: [] },
            nowMs: NOW,
        });
        expect(candidates).toEqual([expect.objectContaining({
                code: 'OVERSELL_EXPOSURE', severity: 'critical', sku: 'LEICA-1',
            })]);
    });
    it('flags repeated end rejections — critical while live, warning once ended (L75)', () => {
        const signals = {
            oldestUnresolvedOrder: null,
            unresolvedCreates: [],
            unresolvedFulfillments: [],
            repeatedPriceFailures: [],
            repeatedEndFailures: [{ sku: 'LEICA-1', count: 34, lastAtUtc: FRESH }],
        };
        const live = evaluateIncidentCandidates({
            snapshot: { observedAtUtc: FRESH, rows: [row('LEICA-1', 0, '147000000001')] },
            signals, nowMs: NOW,
        });
        expect(live.find((candidate) => candidate.code === 'END_DISPATCH_REJECTED'))
            .toMatchObject({ severity: 'critical' });
        // IN-STOCK churn (the 16437396 chronic zombie) must never page as a
        // sell-out emergency.
        const inStock = evaluateIncidentCandidates({
            snapshot: { observedAtUtc: FRESH, rows: [row('LEICA-1', 106, '147000000001')] },
            signals, nowMs: NOW,
        });
        expect(inStock.find((candidate) => candidate.code === 'END_DISPATCH_REJECTED'))
            .toMatchObject({ severity: 'warning' });
        const ended = evaluateIncidentCandidates({
            snapshot: { observedAtUtc: FRESH, rows: [row('LEICA-1', 0, null)] },
            signals, nowMs: NOW,
        });
        expect(ended.find((candidate) => candidate.code === 'END_DISPATCH_REJECTED'))
            .toMatchObject({ severity: 'warning' });
    });
    it('flags aging unresolved creates and stale snapshots as warnings', () => {
        const candidates = evaluateIncidentCandidates({
            snapshot: {
                observedAtUtc: new Date(NOW - 50 * 60_000).toISOString(),
                rows: [row('OK-1', 3, '147000000009'), row('STUCK-1', 1, null)],
            },
            signals: {
                oldestUnresolvedOrder: null,
                unresolvedFulfillments: [],
                repeatedPriceFailures: [],
                unresolvedCreates: [
                    { sku: 'STUCK-1', jobId: 'j1', reservedAtUtc: new Date(NOW - 2 * 3_600_000).toISOString() },
                    { sku: 'FRESH-1', jobId: 'j2', reservedAtUtc: new Date(NOW - 5 * 60_000).toISOString() },
                    // Vanished SKU (sold+archived, no catalog row): bookkeeping, not
                    // an incident.
                    { sku: 'GONE-1', jobId: 'j3', reservedAtUtc: new Date(NOW - 9 * 3_600_000).toISOString() },
                ],
                repeatedEndFailures: [],
            },
            nowMs: NOW,
        });
        expect(candidates.map((candidate) => candidate.code).sort())
            .toEqual(['SNAPSHOT_STALE', 'UNRESOLVED_CREATE_AGING']);
        expect(candidates.find((candidate) => candidate.code === 'UNRESOLVED_CREATE_AGING')?.sku)
            .toBe('STUCK-1');
    });
    it('stays silent on a healthy store', () => {
        expect(evaluateIncidentCandidates({
            snapshot: { observedAtUtc: FRESH, rows: [row('OK-1', 2, '147000000009'), row('OK-2', 1, null)] },
            signals: { oldestUnresolvedOrder: null, unresolvedCreates: [], unresolvedFulfillments: [], repeatedEndFailures: [], repeatedPriceFailures: [] },
            nowMs: NOW,
        })).toEqual([]);
    });
});
describe('runWatchdogOnce', () => {
    const roots = [];
    afterEach(() => { for (const root of roots.splice(0))
        fs.rmSync(root, { recursive: true, force: true }); });
    function tempStateFile() {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'incident-watchdog-'));
        roots.push(root);
        return path.join(root, 'incidents.json');
    }
    it('requires oversell exposure to persist across two sightings, then diagnoses and escalates', async () => {
        const stateFile = tempStateFile();
        const diagnosed = [];
        const issues = [];
        const dependencies = {
            stateFile,
            getSnapshot: async () => ({ observedAtUtc: FRESH, rows: [row('LEICA-1', 0, '147000000001')] }),
            getLedgerSignals: () => ({ oldestUnresolvedOrder: null, unresolvedCreates: [], unresolvedFulfillments: [], repeatedEndFailures: [], repeatedPriceFailures: [] }),
            diagnose: async (incident) => { diagnosed.push(incident); return 'WHAT HAPPENED: test'; },
            openIssue: async (incident) => { issues.push(incident); return 'https://github.com/x/y/issues/1'; },
            notify: async () => undefined,
            learningsContext: () => 'L75: ...',
        };
        await runWatchdogOnce({ ...dependencies, now: () => NOW });
        expect(getIncidents()).toEqual([]); // first sighting: pending only
        await runWatchdogOnce({ ...dependencies, now: () => NOW + 9 * 60_000 });
        const incidents = getIncidents();
        expect(incidents).toHaveLength(1);
        expect(incidents[0]).toMatchObject({
            code: 'OVERSELL_EXPOSURE',
            diagnosisState: 'done',
            diagnosis: 'WHAT HAPPENED: test',
            githubIssueUrl: 'https://github.com/x/y/issues/1',
        });
        expect(diagnosed).toHaveLength(1);
        expect(issues).toHaveLength(1);
    });
    it('sends a publish block to the fix agent without emailing the operator', async () => {
        const stateFile = tempStateFile();
        const issues = [];
        let notified = 0;
        await runWatchdogOnce({
            stateFile,
            now: () => NOW,
            getSnapshot: async () => ({ observedAtUtc: FRESH, rows: [] }),
            getLedgerSignals: () => ({ oldestUnresolvedOrder: null, unresolvedCreates: [], unresolvedFulfillments: [], repeatedEndFailures: [], repeatedPriceFailures: [] }),
            getPublishStatus: () => ({ state: 'finished', stopReason: null, items: [
                    { sku: 'X-1', title: 'X', status: 'failed', reason: 'Preflight refused X-1: CREATE_IDENTITY_MISMATCH' },
                ] }),
            diagnose: async () => 'WHAT HAPPENED: identity drift',
            openIssue: async (incident) => { issues.push(incident); return 'https://github.com/x/y/issues/2'; },
            notify: async () => { notified += 1; },
            learningsContext: () => '',
        });
        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({ code: 'PUBLISH_ITEM_BLOCKED', severity: 'warning' });
        expect(notified).toBe(0);
    });
    it('shows a verified no-photos skip to the operator but never sends it to the fix agent (incident #194)', async () => {
        const stateFile = tempStateFile();
        let diagnosed = 0;
        const issues = [];
        await runWatchdogOnce({
            stateFile,
            now: () => NOW,
            getSnapshot: async () => ({ observedAtUtc: FRESH, rows: [] }),
            getLedgerSignals: () => ({ oldestUnresolvedOrder: null, unresolvedCreates: [], unresolvedFulfillments: [], repeatedEndFailures: [], repeatedPriceFailures: [] }),
            getPublishStatus: () => ({ state: 'finished', stopReason: null, items: [
                    { sku: 'SEL100400GM-U665', title: 'X', status: 'skipped', reason: OPERATOR_DATA_SKIP_REASONS[0] },
                ] }),
            diagnose: async () => { diagnosed += 1; return 'WHAT HAPPENED: no photos'; },
            openIssue: async (incident) => { issues.push(incident); return 'https://github.com/x/y/issues/3'; },
            notify: async () => undefined,
            learningsContext: () => '',
        });
        expect(getIncidents()).toEqual([expect.objectContaining({
                code: 'PUBLISH_ITEM_BLOCKED', sku: 'SEL100400GM-U665', operatorOnly: true, diagnosisState: 'none',
            })]);
        expect(getIncidents()[0].detail).toContain('only you can change');
        expect(diagnosed).toBe(0);
        expect(issues).toHaveLength(0);
    });
    it('clears incidents when the condition resolves and stays quiet unarmed', async () => {
        const stateFile = tempStateFile();
        let rows = [row('LEICA-1', 0, '147000000001')];
        const dependencies = {
            stateFile,
            getSnapshot: async () => ({ observedAtUtc: FRESH, rows }),
            getLedgerSignals: () => ({ oldestUnresolvedOrder: null, unresolvedCreates: [], unresolvedFulfillments: [], repeatedEndFailures: [], repeatedPriceFailures: [] }),
            diagnose: async () => { throw new Error('unarmed'); },
            openIssue: async () => null,
            notify: async () => undefined,
            learningsContext: () => '',
        };
        await runWatchdogOnce({ ...dependencies, now: () => NOW });
        await runWatchdogOnce({ ...dependencies, now: () => NOW + 9 * 60_000 });
        expect(getIncidents()).toHaveLength(1);
        expect(getIncidents()[0].diagnosisState).toBe('none'); // unarmed, not failed
        rows = [row('LEICA-1', 0, null)]; // listing ended
        await runWatchdogOnce({ ...dependencies, now: () => NOW + 20 * 60_000 });
        expect(getIncidents()).toEqual([]);
    });
});
describe('ORDER_PIPELINE_BLOCKED (L77)', () => {
    it('flags an unresolved order observation older than 30 minutes as critical', () => {
        const candidates = evaluateIncidentCandidates({
            snapshot: { observedAtUtc: FRESH, rows: [] },
            signals: {
                oldestUnresolvedOrder: {
                    orderId: '21-15190-74821',
                    observedAtUtc: new Date(NOW - 40 * 3_600_000).toISOString(),
                },
                unresolvedCreates: [], unresolvedFulfillments: [], repeatedEndFailures: [], repeatedPriceFailures: [],
            },
            nowMs: NOW,
        });
        expect(candidates).toEqual([expect.objectContaining({
                code: 'ORDER_PIPELINE_BLOCKED', severity: 'critical',
            })]);
        expect(candidates[0].title).toContain('21-15190-74821');
    });
    it('stays quiet inside the 30-minute import window', () => {
        expect(evaluateIncidentCandidates({
            snapshot: { observedAtUtc: FRESH, rows: [] },
            signals: {
                oldestUnresolvedOrder: {
                    orderId: '21-15190-74821',
                    observedAtUtc: new Date(NOW - 5 * 60_000).toISOString(),
                },
                unresolvedCreates: [], unresolvedFulfillments: [], repeatedEndFailures: [], repeatedPriceFailures: [],
            },
            nowMs: NOW,
        })).toEqual([]);
    });
});
describe('PRICE_SYNC_REJECTED (L87)', () => {
    it('pages critical when eBay rejects price updates for a live listing', () => {
        const candidates = evaluateIncidentCandidates({
            snapshot: { observedAtUtc: FRESH, rows: [row('LENS-5', 2, '147520586676')] },
            signals: {
                oldestUnresolvedOrder: null, unresolvedCreates: [], unresolvedFulfillments: [],
                repeatedEndFailures: [],
                repeatedPriceFailures: [{ sku: 'LENS-5', count: 11, lastAtUtc: FRESH }],
            },
            nowMs: NOW,
        });
        const incident = candidates.find((candidate) => candidate.code === 'PRICE_SYNC_REJECTED');
        expect(incident).toMatchObject({ severity: 'critical' });
        expect(incident.detail).toContain('old price');
    });
    it('downgrades to warning once the listing is no longer live', () => {
        const candidates = evaluateIncidentCandidates({
            snapshot: { observedAtUtc: FRESH, rows: [row('LENS-5', 2, null)] },
            signals: {
                oldestUnresolvedOrder: null, unresolvedCreates: [], unresolvedFulfillments: [],
                repeatedEndFailures: [],
                repeatedPriceFailures: [{ sku: 'LENS-5', count: 4, lastAtUtc: FRESH }],
            },
            nowMs: NOW,
        });
        expect(candidates.find((candidate) => candidate.code === 'PRICE_SYNC_REJECTED'))
            .toMatchObject({ severity: 'warning' });
    });
    it('quotes THIS listing\'s latest non-empty price rejection, never a blank (#209)', () => {
        const providerRejections = [
            { call: 'ReviseInventoryStatus', listingId: '147521467887', reason: '[21919188] Older reason.', atUtc: FRESH },
            { call: 'ReviseInventoryStatus', listingId: '147521467887', reason: '', atUtc: FRESH },
            { call: 'ReviseInventoryStatus', listingId: '147000000001', reason: 'Another listing.', atUtc: FRESH },
            { call: 'EndFixedPriceItem', listingId: '147521467887', reason: 'An end, not a price.', atUtc: FRESH },
        ];
        const evaluate = (rejections) => evaluateIncidentCandidates({
            snapshot: { observedAtUtc: FRESH, rows: [row('LENS-9', 1, '147521467887')] },
            signals: {
                oldestUnresolvedOrder: null, unresolvedCreates: [], unresolvedFulfillments: [],
                repeatedEndFailures: [],
                repeatedPriceFailures: [{ sku: 'listing 147521467887', count: 3, lastAtUtc: FRESH }],
            },
            nowMs: NOW,
            providerRejections: rejections,
        }).find((candidate) => candidate.code === 'PRICE_SYNC_REJECTED');
        expect(evaluate(providerRejections).detail)
            .toContain("eBay's own reason for the most recent rejection: [21919188] Older reason.");
        const blank = evaluate([{ call: 'ReviseInventoryStatus', reason: '', atUtc: FRESH }]).detail;
        expect(blank).not.toMatch(/rejection: $/u);
        expect(blank).toContain('EBAY_TRADING_REJECTED lines naming item=147521467887');
    });
    const SALE_REASON = '[21919248] The price for this item cannot be updated since it is a part of a sale.: '
        + 'The price for this item cannot be updated since it is a part of a sale. If you wish to update the '
        + 'price of this item, please remove it from sale, or use a sale setting that will always allow price updates.';
    const saleSignals = {
        oldestUnresolvedOrder: null, unresolvedCreates: [], unresolvedFulfillments: [],
        repeatedEndFailures: [],
        repeatedPriceFailures: [{ sku: 'listing 147487396129', count: 3, lastAtUtc: FRESH }],
    };
    const saleRejections = [
        { call: 'ReviseInventoryStatus', listingId: '147487396129', reason: SALE_REASON, atUtc: FRESH },
    ];
    it('names a price-locking markdown sale as an operator-only listing setting (#221)', () => {
        const incident = evaluateIncidentCandidates({
            snapshot: { observedAtUtc: FRESH, rows: [row('LENS-7', 1, '147487396129')] },
            signals: saleSignals,
            nowMs: NOW,
            providerRejections: saleRejections,
        }).find((candidate) => candidate.code === 'PRICE_SYNC_REJECTED');
        expect(incident).toMatchObject({ severity: 'critical', operatorOnly: true });
        expect(incident.detail).toContain('markdown sale');
        expect(incident.detail).toContain('Marketing > Promotions');
        expect(incident.detail).not.toContain('Set the price manually on eBay');
        expect(incident.detail).toContain('[21919248]');
        // Any other refusal stays a pipeline incident for the fix agent.
        const other = evaluateIncidentCandidates({
            snapshot: { observedAtUtc: FRESH, rows: [row('LENS-7', 1, '147487396129')] },
            signals: saleSignals,
            nowMs: NOW,
            providerRejections: [{ ...saleRejections[0], reason: '[23004] Best Offer auto accept.' }],
        }).find((candidate) => candidate.code === 'PRICE_SYNC_REJECTED');
        expect(other.operatorOnly).toBeUndefined();
    });
    it('classifies the same sale lock from the Best Offer price-write path', () => {
        const incident = evaluateIncidentCandidates({
            snapshot: { observedAtUtc: FRESH, rows: [row('LENS-7', 1, '147487396129')] },
            signals: saleSignals,
            nowMs: NOW,
            providerRejections: [{
                    call: 'ReviseFixedPriceItem', listingId: '147487396129', reason: SALE_REASON, atUtc: FRESH,
                }],
        }).find((candidate) => candidate.code === 'PRICE_SYNC_REJECTED');
        expect(incident).toMatchObject({ severity: 'critical', operatorOnly: true });
        expect(incident.detail).toContain('Marketing > Promotions');
        expect(incident.detail).toContain('[21919248]');
        expect(incident.detail).not.toContain('The price for this item cannot be updated');
    });
    it('alerts the operator about a markdown-sale lock but never sends it to the fix agent (#221)', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'incident-watchdog-'));
        try {
            let diagnosed = 0;
            let notified = 0;
            const issues = [];
            await runWatchdogOnce({
                stateFile: path.join(root, 'incidents.json'),
                now: () => NOW,
                getSnapshot: async () => ({ observedAtUtc: FRESH, rows: [row('LENS-7', 1, '147487396129')] }),
                getLedgerSignals: () => saleSignals,
                getProviderRejections: () => saleRejections,
                diagnose: async () => { diagnosed += 1; return 'WHAT HAPPENED: sale'; },
                openIssue: async (incident) => { issues.push(incident); return 'https://github.com/x/y/issues/4'; },
                notify: async () => { notified += 1; },
                learningsContext: () => '',
            });
            expect(getIncidents()).toEqual([expect.objectContaining({
                    code: 'PRICE_SYNC_REJECTED', operatorOnly: true, diagnosisState: 'none',
                })]);
            expect(diagnosed).toBe(0);
            expect(issues).toHaveLength(0);
            expect(notified).toBe(1); // the live listing's price is wrong: the operator still hears once
            // The sale lock is lifted but eBay now refuses for a code-fixable
            // reason: the persisted operator-only flag must not keep it from the
            // fix agent.
            await runWatchdogOnce({
                stateFile: path.join(root, 'incidents.json'),
                now: () => NOW + 5 * 60_000,
                getSnapshot: async () => ({ observedAtUtc: FRESH, rows: [row('LENS-7', 1, '147487396129')] }),
                getLedgerSignals: () => saleSignals,
                getProviderRejections: () => [{ ...saleRejections[0], reason: '[23004] Best Offer auto accept.' }],
                diagnose: async () => { diagnosed += 1; return 'WHAT HAPPENED: best offer'; },
                openIssue: async (incident) => { issues.push(incident); return 'https://github.com/x/y/issues/5'; },
                notify: async () => { notified += 1; },
                learningsContext: () => '',
            });
            expect(getIncidents()[0].operatorOnly).toBeUndefined();
            expect(diagnosed).toBe(1);
            expect(issues).toHaveLength(1);
        }
        finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
describe('PUBLISH_ITEM_BLOCKED (self-healing publish path)', () => {
    it('groups items by root cause and ignores published ones', () => {
        const candidates = publishBlockCandidates([
            { sku: 'A-1', status: 'published' },
            { sku: '82-25-VND-ED2-U001', status: 'failed', reason: 'Preflight refused 82-25-VND-ED2-U001: CREATE_IDENTITY_MISMATCH' },
            { sku: 'B-2', status: 'failed', reason: 'Preflight refused B-2: CREATE_IDENTITY_MISMATCH' },
            { sku: 'C-3', status: 'skipped', reason: 'eBay requires Mount for this category (Item specifics written by the agent: Type = Zoom; the rest were not certain) — open the item.' },
            { sku: 'D-4', status: 'skipped', reason: 'eBay requires Focal Length, Type for this category — open the item.' },
        ]);
        expect(candidates.map((candidate) => candidate.id)).toEqual([
            'PUBLISH_ITEM_BLOCKED:CREATE_IDENTITY_MISMATCH',
            'PUBLISH_ITEM_BLOCKED:eBay requires <aspects> for this category — open the item.',
        ]);
        expect(candidates[0]).toMatchObject({ severity: 'warning', sku: '82-25-VND-ED2-U001' });
        expect(candidates[0].title).toContain('2 items');
        expect(candidates[0].detail).toContain('B-2: Preflight refused B-2: CREATE_IDENTITY_MISMATCH');
    });
    it('marks a group operator-only only when every item is verified store data', () => {
        const [photos] = OPERATOR_DATA_SKIP_REASONS;
        expect(publishBlockCandidates([{ sku: 'A-1', status: 'skipped', reason: photos }])[0])
            .toMatchObject({ operatorOnly: true });
        expect(publishBlockCandidates([
            { sku: 'A-1', status: 'failed', reason: 'Preflight refused A-1: CREATE_IDENTITY_MISMATCH' },
        ])[0]).toMatchObject({ operatorOnly: false });
    });
    it('is silent when every item published', () => {
        expect(publishBlockCandidates([{ sku: 'A-1', status: 'published' }])).toEqual([]);
    });
});
