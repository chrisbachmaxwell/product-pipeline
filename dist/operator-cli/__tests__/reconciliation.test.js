import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_RECONCILIATION_SNAPSHOT_BYTES, parseReconciliationSnapshot, ReconciliationSnapshotError, runSnapshotReconciliation, } from '../reconciliation.js';
import { buildOperatorProgram } from '../program.js';
import { markSourceUnavailable, refreshReconciliationSource, validConfig, validReconciliationSnapshot, } from './fixtures.js';
const temporaryDirectories = [];
async function tempRepo(snapshot = validReconciliationSnapshot(), config = validConfig()) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'product-pipeline-reconciliation-'));
    temporaryDirectories.push(root);
    await fs.mkdir(path.join(root, '.git'));
    await fs.mkdir(path.join(root, 'config'));
    await fs.mkdir(path.join(root, '.local/operator-reconciliation'), { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'product-pipeline', type: 'module' }));
    await fs.writeFile(path.join(root, 'config/operator.json'), JSON.stringify(config));
    await fs.writeFile(path.join(root, '.local/operator-reconciliation/snapshot.json'), JSON.stringify(snapshot));
    return root;
}
const cloneSnapshot = () => structuredClone(validReconciliationSnapshot());
afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});
describe('reconciliation snapshot schema v2', () => {
    it('accepts exact complete provenance and binds every dataset digest', () => {
        const snapshot = validReconciliationSnapshot();
        const parsed = parseReconciliationSnapshot(snapshot);
        expect(parsed.schemaVersion).toBe(2);
        expect(parsed.sources.marketplaceConnect.provenance).toMatchObject({
            method: 'operator-attested-admin-view',
            attestation: 'operator-attested',
            availability: 'complete',
            apiVersion: null,
        });
        expect(parsed.sources.shopify.provenance.apiVersion).toBe('2025-07');
        expect(parsed.sources.ebay.provenance.apiVersion).toBe('sell-v1');
        expect(parsed.sources.marketplaceConnect.provenance.terminalCursorDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(parsed.sources.marketplaceConnect.provenance.datasetDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    });
    it('requires total and terminal pagination evidence for every complete capture', () => {
        const missingTotal = cloneSnapshot();
        missingTotal.sources.shopify.provenance.reportedTotal = null;
        expect(() => parseReconciliationSnapshot(missingTotal)).toThrow(/reportedTotal is required when availability is complete/);
        const missingTerminal = cloneSnapshot();
        missingTerminal.sources.shopify.provenance.terminalCursorDigest = null;
        expect(() => parseReconciliationSnapshot(missingTerminal)).toThrow(/terminalCursorDigest is required when availability is complete/);
        const mismatchedTotal = cloneSnapshot();
        mismatchedTotal.sources.shopify.provenance.reportedTotal = 1_000;
        expect(() => parseReconciliationSnapshot(mismatchedTotal)).toThrow(/reportedTotal must equal recordCount when availability is complete/);
    });
    it('permits a complete zero-record capture only with explicit total and terminal proof', () => {
        const snapshot = cloneSnapshot();
        snapshot.sources.shopify.data = { variants: [], orders: [] };
        refreshReconciliationSource(snapshot, 'shopify');
        expect(parseReconciliationSnapshot(snapshot).sources.shopify.provenance).toMatchObject({
            availability: 'complete',
            paginationComplete: true,
            pageCount: 1,
            recordCount: 0,
            reportedTotal: 0,
        });
        snapshot.sources.shopify.provenance.pageCount = 0;
        snapshot.sources.shopify.provenance.terminalCursorDigest = null;
        expect(() => parseReconciliationSnapshot(snapshot)).toThrow(/terminal-page evidence/);
    });
    it('requires API version provenance for available direct reads', () => {
        const snapshot = cloneSnapshot();
        snapshot.sources.ebay.provenance.apiVersion = null;
        expect(() => parseReconciliationSnapshot(snapshot)).toThrow(/apiVersion is required for an available direct API read/);
    });
    it('denies a tampered dataset digest', () => {
        const snapshot = cloneSnapshot();
        snapshot.sources.ebay.data.listings[0].priceMinor += 1;
        expect(() => parseReconciliationSnapshot(snapshot)).toThrow(/datasetDigest does not match/);
    });
    it('denies a source subject that does not exactly match root identities', () => {
        const snapshot = cloneSnapshot();
        snapshot.sources.ebay.provenance.subject.ebaySellerAccount = 'different-seller';
        expect(() => parseReconciliationSnapshot(snapshot)).toThrow(/must exactly match/);
    });
    it('denies treating Marketplace Connect UI observation as a direct API read', () => {
        const snapshot = cloneSnapshot();
        snapshot.sources.marketplaceConnect.provenance.method = 'direct-api-read';
        expect(() => parseReconciliationSnapshot(snapshot)).toThrow(/operator-attested-admin-view/);
    });
    it('accepts unavailable evidence only with empty arrays and null count/digest semantics', () => {
        const snapshot = cloneSnapshot();
        markSourceUnavailable(snapshot, 'shopify', 'credentials-unavailable');
        expect(parseReconciliationSnapshot(snapshot).sources.shopify.provenance).toMatchObject({
            availability: 'unavailable',
            paginationComplete: false,
            pageCount: 0,
            recordCount: null,
            reportedTotal: null,
            apiVersion: null,
            terminalCursorDigest: null,
            datasetDigest: null,
        });
        snapshot.sources.shopify.provenance.recordCount = 0;
        expect(() => parseReconciliationSnapshot(snapshot)).toThrow(/unavailable evidence requires/);
    });
    it('rejects personal-data and secret-like fields without echoing values', () => {
        const snapshot = cloneSnapshot();
        const privateValue = 'private-person-value';
        snapshot.sources.ebay.data.orders[0].buyerUsername = privateValue;
        expect(() => parseReconciliationSnapshot(snapshot)).toThrow(ReconciliationSnapshotError);
        try {
            parseReconciliationSnapshot(snapshot);
        }
        catch (error) {
            expect(error.message).toContain('buyerUsername');
            expect(error.message).not.toContain(privateValue);
        }
    });
});
describe('snapshot reconciliation evidence and safety', () => {
    it('compares complete snapshots without network or application database access', async () => {
        const root = await tempRepo();
        const snapshotPath = path.join(root, '.local/operator-reconciliation/snapshot.json');
        const before = await fs.readFile(snapshotPath, 'utf8');
        const databaseSentinel = path.join(root, 'application-database-must-not-exist.db');
        const previousDatabasePath = process.env.DATABASE_PATH;
        process.env.DATABASE_PATH = databaseSentinel;
        const fetchSpy = vi.fn(() => { throw new Error('network access is forbidden'); });
        vi.stubGlobal('fetch', fetchSpy);
        const result = await (async () => {
            try {
                return await runSnapshotReconciliation({
                    repoRoot: root,
                    configPath: 'config/operator.json',
                    snapshotPath: '.local/operator-reconciliation/snapshot.json',
                    now: () => new Date('2026-08-11T16:01:00.000Z'),
                    createRunId: () => 'reconcile-run',
                });
            }
            finally {
                if (previousDatabasePath === undefined)
                    delete process.env.DATABASE_PATH;
                else
                    process.env.DATABASE_PATH = previousDatabasePath;
            }
        })();
        expect(result.status).toBe('exceptions-found');
        expect(result.discrepancies).toEqual([]);
        expect(result.generatedAtUtc).toBe('2026-08-11T16:00:00.000Z');
        expect('capturedAtUtc' in result).toBe(false);
        expect(result.sourceEvidence.every((source) => source.complete)).toBe(true);
        expect(result.sourceEvidence.find((source) => source.source === 'marketplaceConnect')).toMatchObject({
            attestation: 'operator-attested', apiVersion: null, liveProof: false,
        });
        expect(result.responsibilityEvidence.find((item) => item.responsibility === 'reconciliation')).toMatchObject({
            state: 'consistent-with-supplied-evidence',
            blockers: [],
        });
        const operationalEvidence = result.responsibilityEvidence.filter((item) => item.responsibility !== 'reconciliation');
        expect(operationalEvidence.every((item) => item.state === 'blocked')).toBe(true);
        for (const item of operationalEvidence) {
            expect(item.blockers).toContain(`responsibility.${item.responsibility}.model-coverage-incomplete`);
            expect(item).toMatchObject({ liveProof: false, productionParity: false, canaryReady: false });
        }
        expect(result.guarantees).toEqual({
            liveProof: false, productionParity: false, externalNetworkAccess: false, externalWrites: 0,
            applicationDatabaseAccess: false, historicalBackfill: false, orderCreationEligible: false,
        });
        expect(fetchSpy).not.toHaveBeenCalled();
        await expect(fs.stat(databaseSentinel)).rejects.toThrow();
        expect(await fs.readFile(snapshotPath, 'utf8')).toBe(before);
        const auditText = await fs.readFile(path.join(root, '.local/operator-audit/operator-cli.jsonl'), 'utf8');
        expect(auditText).toContain('reconciliation.exceptions-absent');
        expect(auditText).toContain('"result":"block"');
    });
    it('produces an actionable blocked baseline when direct sources are unavailable', async () => {
        const snapshot = cloneSnapshot();
        markSourceUnavailable(snapshot, 'productPipeline', 'collector-unavailable');
        markSourceUnavailable(snapshot, 'shopify', 'credentials-unavailable');
        markSourceUnavailable(snapshot, 'ebay', 'credentials-unavailable');
        const root = await tempRepo(snapshot);
        const result = await runSnapshotReconciliation({
            repoRoot: root, configPath: 'config/operator.json',
            snapshotPath: '.local/operator-reconciliation/snapshot.json',
            now: () => new Date('2026-08-11T16:01:00.000Z'),
        });
        expect(result.status).toBe('exceptions-found');
        expect(result.sourceEvidence.find((item) => item.source === 'marketplaceConnect')).toMatchObject({ complete: true, liveProof: false });
        expect(result.sourceEvidence.filter((item) => item.availability === 'unavailable')).toHaveLength(3);
        expect(result.responsibilityEvidence.find((item) => item.responsibility === 'orderImport')).toMatchObject({
            owner: 'marketplace-connect',
            ownerBasis: 'accepted-marketplace-connect-baseline',
            state: 'blocked',
            ownershipTransferred: false,
            canaryReady: false,
        });
    });
    it('blocks partial pagination and reported-total mismatch without rejecting valid partial evidence', async () => {
        const snapshot = cloneSnapshot();
        snapshot.sources.shopify.provenance.availability = 'partial';
        snapshot.sources.shopify.provenance.paginationComplete = false;
        snapshot.sources.shopify.provenance.reportedTotal = 9;
        snapshot.sources.shopify.provenance.terminalCursorDigest = null;
        const root = await tempRepo(snapshot);
        const result = await runSnapshotReconciliation({
            repoRoot: root, configPath: 'config/operator.json',
            snapshotPath: '.local/operator-reconciliation/snapshot.json',
            now: () => new Date('2026-08-11T16:01:00.000Z'),
        });
        const shopify = result.sourceEvidence.find((item) => item.source === 'shopify');
        expect(shopify?.blockers).toEqual(expect.arrayContaining([
            'source.shopify.partial',
            'source.shopify.pagination-incomplete',
            'source.shopify.reported-total-mismatch',
            'source.shopify.terminal-cursor-proof-unavailable',
        ]));
        expect(result.responsibilityEvidence.find((item) => item.responsibility === 'price')?.state).toBe('blocked');
    });
    it('blocks stale, future, and cross-source-skewed evidence per source', async () => {
        const stale = cloneSnapshot();
        stale.sources.productPipeline.provenance.asOfEndUtc = '2026-08-09T15:59:00.000Z';
        stale.sources.productPipeline.provenance.asOfStartUtc = '2026-08-09T15:00:00.000Z';
        stale.sources.productPipeline.provenance.queryScope.lowerBoundUtc = '2026-08-09T14:00:00.000Z';
        const staleRoot = await tempRepo(stale);
        const staleResult = await runSnapshotReconciliation({
            repoRoot: staleRoot, configPath: 'config/operator.json', snapshotPath: '.local/operator-reconciliation/snapshot.json',
            now: () => new Date('2026-08-11T16:01:00.000Z'),
        });
        expect(staleResult.sourceEvidence.find((item) => item.source === 'productPipeline')?.blockers).toContain('source.productPipeline.stale');
        expect(staleResult.sourceEvidence.find((item) => item.source === 'ebay')?.blockers).toContain('source.cross-source-as-of-skew');
        const future = cloneSnapshot();
        future.sources.ebay.provenance.capturedAtUtc = '2026-08-11T17:00:00.000Z';
        future.sources.ebay.provenance.asOfStartUtc = '2026-08-11T16:20:00.000Z';
        future.sources.ebay.provenance.asOfEndUtc = '2026-08-11T16:30:00.000Z';
        future.sources.ebay.provenance.queryScope.lowerBoundUtc = '2026-08-11T16:20:00.000Z';
        future.sources.ebay.provenance.queryScope.upperBoundUtc = '2026-08-11T17:00:00.000Z';
        const futureRoot = await tempRepo(future);
        const futureResult = await runSnapshotReconciliation({
            repoRoot: futureRoot, configPath: 'config/operator.json', snapshotPath: '.local/operator-reconciliation/snapshot.json',
            now: () => new Date('2026-08-11T16:01:00.000Z'),
        });
        const futureEvidence = futureResult.sourceEvidence.find((item) => item.source === 'ebay');
        expect(futureEvidence?.freshness).toBe('future');
        expect(futureEvidence?.blockers).toEqual(expect.arrayContaining([
            'source.ebay.future',
            'source.ebay.captured-at-future',
            'source.ebay.query-lower-bound-future',
            'source.ebay.query-upper-bound-future',
        ]));
    });
    it('blocks a snapshot generation timestamp beyond the allowed clock skew', async () => {
        const snapshot = cloneSnapshot();
        snapshot.generatedAtUtc = '2026-08-11T17:00:00.000Z';
        const root = await tempRepo(snapshot);
        const result = await runSnapshotReconciliation({
            repoRoot: root,
            configPath: 'config/operator.json',
            snapshotPath: '.local/operator-reconciliation/snapshot.json',
            now: () => new Date('2026-08-11T16:01:00.000Z'),
        });
        expect(result.discrepancies).toContainEqual(expect.objectContaining({
            code: 'snapshot.generated-at-future',
            responsibility: 'reconciliation',
            severity: 'critical',
        }));
        expect(result.responsibilityEvidence.find((item) => item.responsibility === 'reconciliation')?.state).toBe('blocked');
    });
    it('keeps an empty partial self-asserted capture blocked without terminal evidence', async () => {
        const snapshot = cloneSnapshot();
        snapshot.sources.shopify.data = { variants: [], orders: [] };
        refreshReconciliationSource(snapshot, 'shopify');
        snapshot.sources.shopify.provenance.availability = 'partial';
        snapshot.sources.shopify.provenance.paginationComplete = false;
        snapshot.sources.shopify.provenance.reportedTotal = null;
        snapshot.sources.shopify.provenance.terminalCursorDigest = null;
        const root = await tempRepo(snapshot);
        const result = await runSnapshotReconciliation({
            repoRoot: root,
            configPath: 'config/operator.json',
            snapshotPath: '.local/operator-reconciliation/snapshot.json',
            now: () => new Date('2026-08-11T16:01:00.000Z'),
        });
        expect(result.sourceEvidence.find((item) => item.source === 'shopify')).toMatchObject({
            complete: false,
            recordCount: 0,
            reportedTotal: null,
            terminalCursorDigest: null,
        });
        expect(result.sourceEvidence.find((item) => item.source === 'shopify')?.blockers).toEqual(expect.arrayContaining([
            'source.shopify.partial',
            'source.shopify.pagination-incomplete',
            'source.shopify.reported-total-unavailable',
            'source.shopify.terminal-cursor-proof-unavailable',
        ]));
        expect(result.responsibilityEvidence.find((item) => item.responsibility === 'reconciliation')?.state).toBe('blocked');
    });
    it('detects duplicate Shopify and eBay SKUs and withholds ambiguous SKU joins', async () => {
        const snapshot = cloneSnapshot();
        snapshot.sources.shopify.data.variants.push({
            ...snapshot.sources.shopify.data.variants[0],
            shopifyProductGid: 'gid://shopify/Product/200',
            shopifyVariantGid: 'gid://shopify/ProductVariant/201',
            priceMinor: 999,
        });
        snapshot.sources.ebay.data.listings.push({
            ...snapshot.sources.ebay.data.listings[0],
            offerId: 'OFFER-002', listingId: 'LISTING-002', priceMinor: 777,
        });
        refreshReconciliationSource(snapshot, 'shopify');
        refreshReconciliationSource(snapshot, 'ebay');
        const root = await tempRepo(snapshot);
        const result = await runSnapshotReconciliation({
            repoRoot: root, configPath: 'config/operator.json', snapshotPath: '.local/operator-reconciliation/snapshot.json',
            now: () => new Date('2026-08-11T16:01:00.000Z'),
        });
        expect(result.discrepancies).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'listing.duplicate-shopify-sku', severity: 'critical' }),
            expect.objectContaining({ code: 'listing.duplicate-ebay-inventory-sku', severity: 'critical' }),
        ]));
        expect(result.discrepancies.some((item) => item.code === 'price.observed-difference')).toBe(false);
    });
    it('keeps Marketplace Connect price/inventory observations incumbent-owned and non-writing', async () => {
        const snapshot = cloneSnapshot();
        snapshot.sources.ebay.data.listings[0].priceMinor = 12000;
        snapshot.sources.ebay.data.listings[0].availableQuantity = 0;
        refreshReconciliationSource(snapshot, 'ebay');
        const root = await tempRepo(snapshot);
        const result = await runSnapshotReconciliation({
            repoRoot: root, configPath: 'config/operator.json', snapshotPath: '.local/operator-reconciliation/snapshot.json',
            now: () => new Date('2026-08-11T16:01:00.000Z'),
        });
        expect(result.discrepancies).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'price.observed-difference', owner: 'marketplace-connect' }),
            expect.objectContaining({ code: 'inventory.observed-difference', owner: 'marketplace-connect' }),
        ]));
        expect(JSON.stringify(result)).not.toMatch(/desiredAction|updateRemote|ownershipTransferred":true/);
        expect(result.guarantees.externalWrites).toBe(0);
    });
    it('treats an unlinked eBay order only as an incumbent-owned exception', async () => {
        const snapshot = cloneSnapshot();
        snapshot.sources.productPipeline.data.orders = [];
        snapshot.sources.shopify.data.orders = [];
        refreshReconciliationSource(snapshot, 'productPipeline');
        refreshReconciliationSource(snapshot, 'shopify');
        const root = await tempRepo(snapshot);
        const result = await runSnapshotReconciliation({
            repoRoot: root, configPath: 'config/operator.json', snapshotPath: '.local/operator-reconciliation/snapshot.json',
            now: () => new Date('2026-08-11T16:01:00.000Z'),
        });
        expect(result.discrepancies).toContainEqual(expect.objectContaining({ code: 'order.no-shopify-link-observed', owner: 'marketplace-connect' }));
        expect(result.guarantees.orderCreationEligible).toBe(false);
        expect(result.discrepancies.find((item) => item.code === 'order.no-shopify-link-observed')?.summary).toContain('never an import candidate');
    });
    it('does not transfer ownership from observations', async () => {
        const config = validConfig();
        config.ownership.mapping.currentOwner = 'unverified';
        const root = await tempRepo(validReconciliationSnapshot(), config);
        const result = await runSnapshotReconciliation({
            repoRoot: root, configPath: 'config/operator.json', snapshotPath: '.local/operator-reconciliation/snapshot.json',
            now: () => new Date('2026-08-11T16:01:00.000Z'),
        });
        expect(result.responsibilityEvidence.find((item) => item.responsibility === 'mapping')).toMatchObject({
            owner: 'unverified', ownerBasis: 'operator-configuration', state: 'unverified', ownershipTransferred: false,
        });
    });
    it('denies config/snapshot identity mismatch and audits only configured identity', async () => {
        const config = validConfig({ identities: { ...validConfig().identities, ebaySellerAccount: 'different-seller' } });
        const root = await tempRepo(validReconciliationSnapshot(), config);
        await expect(runSnapshotReconciliation({
            repoRoot: root, configPath: 'config/operator.json', snapshotPath: '.local/operator-reconciliation/snapshot.json',
        })).rejects.toThrow(/identity does not match/);
        const auditText = await fs.readFile(path.join(root, '.local/operator-audit/operator-cli.jsonl'), 'utf8');
        expect(auditText).toContain('reconciliation.identity-mismatch');
        expect(auditText).toContain('different-seller');
    });
    it('requires a regular snapshot beneath the fixed ignored directory and enforces byte limit', async () => {
        const root = await tempRepo();
        await fs.writeFile(path.join(root, 'outside.json'), JSON.stringify(validReconciliationSnapshot()));
        await expect(runSnapshotReconciliation({ repoRoot: root, configPath: 'config/operator.json', snapshotPath: 'outside.json' })).rejects.toThrow(/beneath \.local\/operator-reconciliation/);
        const outside = path.join(root, 'outside.json');
        const link = path.join(root, '.local/operator-reconciliation/link.json');
        await fs.symlink(outside, link);
        await expect(runSnapshotReconciliation({ repoRoot: root, configPath: 'config/operator.json', snapshotPath: '.local/operator-reconciliation/link.json' })).rejects.toThrow(/regular, non-symlink/);
        await fs.writeFile(path.join(root, '.local/operator-reconciliation/oversized.json'), 'x'.repeat(MAX_RECONCILIATION_SNAPSHOT_BYTES + 1));
        await expect(runSnapshotReconciliation({ repoRoot: root, configPath: 'config/operator.json', snapshotPath: '.local/operator-reconciliation/oversized.json' })).rejects.toThrow(/byte limit/);
    });
    it('records dataset/snapshot/result digests, not commerce identifiers, in audit evidence', async () => {
        const root = await tempRepo();
        const result = await runSnapshotReconciliation({
            repoRoot: root, configPath: 'config/operator.json', snapshotPath: '.local/operator-reconciliation/snapshot.json',
            now: () => new Date('2026-08-11T16:01:00.000Z'), createRunId: () => 'audit-reconcile-run',
        });
        const auditText = await fs.readFile(path.join(root, '.local/operator-audit/operator-cli.jsonl'), 'utf8');
        expect(auditText).toContain(result.snapshot.digest.slice('sha256:'.length));
        expect(auditText).toContain(result.resultDigest.slice('sha256:'.length));
        for (const source of result.sourceEvidence)
            expect(auditText).toContain(source.datasetDigest.slice('sha256:'.length));
        expect(auditText).not.toContain('SAFE-SKU-001');
        expect(auditText).not.toContain('EBAY-ORDER-001');
        expect(auditText).not.toContain('LISTING-001');
    });
    it('labels the bundle time as Generated in human CLI output', async () => {
        const root = await tempRepo();
        const output = [];
        const exitCodes = [];
        const program = buildOperatorProgram({
            stdout: (message) => output.push(message),
            stderr: () => undefined,
            setExitCode: (code) => exitCodes.push(code),
        });
        program.exitOverride();
        program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
        await program.parseAsync([
            'reconcile',
            '--repo-root',
            root,
            '--config',
            'config/operator.json',
            '--snapshot',
            '.local/operator-reconciliation/snapshot.json',
        ], { from: 'user' });
        expect(output).toContain('Generated: 2026-08-11T16:00:00.000Z');
        expect(output.some((line) => line.startsWith('Captured:'))).toBe(false);
        expect(exitCodes).toEqual([2]);
    });
});
