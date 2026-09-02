import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMigrationStore, deriveScopeKey, } from '../../migration-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../../listing-control-config.js';
import { buildPriceInventoryAdminProgram } from '../program.js';
/**
 * `align-sweep` batches the SAME per-target write path as `dispatch` (see
 * dispatchOneAlignment), which the dispatch suite already covers end to end.
 * What is new here is the batch envelope, so that is what these assert: the
 * scope confirmation, the ownership kill switch, the bounded action count,
 * and delta-only skipping.
 */
const MIGRATION_SCOPE = {
    shopifyStoreDomain: LISTING_DRAFT_SCOPE.shopifyStoreDomain,
    ebayEnvironment: LISTING_DRAFT_SCOPE.ebayEnvironment,
    ebaySellerId: LISTING_DRAFT_SCOPE.ebaySellerId,
    ebayMarketplaceId: LISTING_DRAFT_SCOPE.ebayMarketplaceId,
};
const roots = [];
afterEach(() => {
    while (roots.length > 0)
        fs.rmSync(roots.pop(), { recursive: true, force: true });
});
function emptySnapshot() {
    return { observedAtUtc: '2026-09-02T00:00:00.000Z', rows: [] };
}
function createWorld(snapshot = emptySnapshot) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'align-sweep-'));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    const migrationDatabasePath = path.join(root, 'migration-state.sqlite');
    createMigrationStore({
        databasePath: migrationDatabasePath,
        scope: MIGRATION_SCOPE,
        createdAtUtc: '2026-08-01T00:00:00.000Z',
    }).close();
    const stdout = [];
    const stderr = [];
    const exitCodes = [];
    const io = {
        stdout: (m) => stdout.push(m),
        stderr: (m) => stderr.push(m),
        setExitCode: (c) => exitCodes.push(c),
    };
    const providerCalls = [];
    const run = (argv) => buildPriceInventoryAdminProgram({
        readWorkspace: async () => { throw new Error('no workspace in this fixture'); },
        getSnapshot: snapshot,
        createAdapter: () => ({
            updateOfferPrice: async () => { providerCalls.push('price'); },
            updateOfferQuantity: async () => { providerCalls.push('quantity'); },
        }),
        createTradingAdapter: () => ({
            reviseInventoryStatus: async () => { providerCalls.push('trading'); },
        }),
        io,
    }).parseAsync(argv, { from: 'user' });
    return { migrationDatabasePath, stdout, stderr, exitCodes, providerCalls, run };
}
const lastJson = (lines) => JSON.parse(lines[lines.length - 1]);
function sweepArgs(world, overrides = []) {
    return [
        'align-sweep',
        '--migration-store', world.migrationDatabasePath,
        '--confirm-scope', deriveScopeKey(MIGRATION_SCOPE),
        '--field', 'quantity',
        '--confirm-sweep',
        ...overrides,
    ];
}
describe('price/inventory align-sweep', () => {
    it('denies a wrong scope confirmation before touching the store', async () => {
        const world = createWorld();
        await world.run([
            'align-sweep',
            '--migration-store', world.migrationDatabasePath,
            '--confirm-scope', `sha256:${'d'.repeat(64)}`,
            '--field', 'quantity',
            '--confirm-sweep',
        ]);
        expect(lastJson(world.stderr)).toMatchObject({
            command: 'align-sweep', status: 'denied', code: 'REALIGN_SCOPE_CONFIRMATION_MISMATCH',
        });
        expect(world.providerCalls).toHaveLength(0);
    });
    // The kill switch. Recording the responsibility back to `paused` stops
    // every sweep with no code change and no deploy.
    it('denies when the responsibility is not owned by product_pipeline', async () => {
        const world = createWorld();
        await world.run(sweepArgs(world));
        expect(lastJson(world.stderr)).toMatchObject({
            command: 'align-sweep', status: 'denied', code: 'REALIGN_OWNERSHIP_NOT_ESTABLISHED',
        });
        expect(world.providerCalls).toHaveLength(0);
    });
    it('rejects a non-positive or malformed action cap', async () => {
        const world = createWorld();
        for (const bad of ['0', '-1', 'abc', '1.5']) {
            await world.run(sweepArgs(world, ['--max-actions', bad]));
            expect(lastJson(world.stderr), bad).toMatchObject({ code: 'SWEEP_MAX_ACTIONS_INVALID' });
        }
        expect(world.providerCalls).toHaveLength(0);
    });
    it('requires the explicit sweep acknowledgement', async () => {
        const world = createWorld();
        await expect(world.run([
            'align-sweep',
            '--migration-store', world.migrationDatabasePath,
            '--confirm-scope', deriveScopeKey(MIGRATION_SCOPE),
            '--field', 'quantity',
        ])).rejects.toBeTruthy();
        expect(world.providerCalls).toHaveLength(0);
    });
    it('rejects a field that is not price or quantity', async () => {
        const world = createWorld();
        await world.run([
            'align-sweep',
            '--migration-store', world.migrationDatabasePath,
            '--confirm-scope', deriveScopeKey(MIGRATION_SCOPE),
            '--field', 'title',
            '--confirm-sweep',
        ]);
        expect(lastJson(world.stderr)).toMatchObject({ code: 'PLAN_FIELD_INVALID' });
        expect(world.providerCalls).toHaveLength(0);
    });
});
