/**
 * Contract tests for the READ-ONLY `shadow-poll` command: the shadow parity
 * mode that runs while Marketplace Connect still owns order import. Only the
 * eBay and Shopify HTTP transports are faked (the real bounded adapters run
 * against fixture responses). The migration store is never even opened — a
 * spy proves it — and the only write the command can ever perform is the
 * operator-named local --report-file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PRODUCT_PIPELINE_SHOPIFY_IDENTITY } from '../../shopify/production-identity.js';
import { createEbayOrderReadAdapter } from '../ebay-order-adapter.js';
import { createShopifyOrderAdapter } from '../shopify-order-adapter.js';
import { buildOrderImportAdminProgram } from '../program.js';
const SHOPIFY_URL = `https://${PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain}`
    + `/admin/api/${PRODUCT_PIPELINE_SHOPIFY_IDENTITY.adminApiVersion}/graphql.json`;
const MATCHED_ORDER_ID = '11-11111-11111';
const UNMATCHED_ORDER_ID = '22-22222-22222';
const MATCHED_GID = 'gid://shopify/Order/7777';
const SKU = 'CAN3570-U119';
const NOW_UTC = '2026-08-20T12:00:00.000Z';
// Fixture PII that must never reach stdout, stderr, or the report file.
const PII_FULL_NAME = 'Fixture Buyer Name';
const PII_STREET = '123 Fixture Street';
const PII_EMAIL = 'fixture-buyer@example.com';
const PII_PHONE = '555-0100';
const PII_STRINGS = [PII_FULL_NAME, PII_STREET, PII_EMAIL, PII_PHONE, 'fixture_buyer'];
const roots = [];
afterEach(() => {
    for (const root of roots.splice(0))
        fs.rmSync(root, { recursive: true, force: true });
});
function makeRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-poll-'));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    return root;
}
function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}
function ebayOrderFixture(orderId, creationDate) {
    return {
        orderId,
        creationDate,
        orderFulfillmentStatus: 'NOT_STARTED',
        orderPaymentStatus: 'PAID',
        pricingSummary: { total: { value: '129.95', currency: 'USD' } },
        lineItems: [{
                lineItemId: `li-${orderId}`,
                sku: SKU,
                title: 'Canon EF 35-70mm Lens',
                quantity: 1,
                lineItemCost: { value: '119.95', currency: 'USD' },
            }],
        buyer: { username: 'fixture_buyer' },
        fulfillmentStartInstructions: [{
                shippingStep: {
                    shipTo: {
                        fullName: PII_FULL_NAME,
                        email: PII_EMAIL,
                        primaryPhone: { phoneNumber: PII_PHONE },
                        contactAddress: {
                            addressLine1: PII_STREET,
                            city: 'Salt Lake City',
                            stateOrProvince: 'UT',
                            postalCode: '84101',
                            countryCode: 'US',
                        },
                    },
                },
            }],
    };
}
function createWorld() {
    const world = {
        ebayListOrders: [],
        ebayBehavior: { mode: 'success' },
        ebayUrls: [],
        shopifyBehavior: { mode: 'success' },
        shopifyHasNextPage: false,
        shopifySourceEchoOverride: null,
        shopifyOperations: [],
        ordersByTag: new Map(),
        ordersBySourceIdentifier: new Map(),
        migrationOpenCalls: 0,
        stateReaderOpenCalls: 0,
        stdout: [],
        stderr: [],
        exitCodes: [],
        run: async () => undefined,
        lastStdout: () => {
            expect(world.stdout.length).toBeGreaterThan(0);
            return JSON.parse(world.stdout[world.stdout.length - 1]);
        },
        lastStderr: () => {
            expect(world.stderr.length).toBeGreaterThan(0);
            return JSON.parse(world.stderr[world.stderr.length - 1]);
        },
        allEmitted: () => world.stdout.join('\n') + world.stderr.join('\n'),
    };
    const ebayFetch = async (input) => {
        const url = String(input);
        world.ebayUrls.push(url);
        if (world.ebayBehavior.mode === 'transport_error') {
            return jsonResponse({ error: 'boom' }, 500);
        }
        if (url.startsWith('https://api.ebay.com/sell/fulfillment/v1/order?')) {
            return jsonResponse({ orders: world.ebayListOrders });
        }
        throw new Error(`unexpected eBay URL: ${url}`);
    };
    const shopifyFetch = async (input, init) => {
        const url = String(input);
        if (url !== SHOPIFY_URL)
            throw new Error(`unexpected Shopify URL: ${url}`);
        const body = JSON.parse(String(init?.body));
        world.shopifyOperations.push(body.operationName);
        if (world.shopifyBehavior.mode === 'transport_error') {
            return jsonResponse({ error: 'boom' }, 500);
        }
        if (body.operationName === 'OrderImportOrdersByTag') {
            const match = /^tag:'(.+)'$/.exec(String(body.variables.query));
            const gids = match ? world.ordersByTag.get(match[1]) ?? [] : [];
            return jsonResponse({ data: { orders: {
                        nodes: gids.map((id) => ({ id, tags: [match[1]], sourceIdentifier: null })),
                        pageInfo: { hasNextPage: world.shopifyHasNextPage },
                    } } });
        }
        if (body.operationName === 'OrderImportOrdersBySourceIdentifier') {
            const match = /^source_identifier:(.+)$/.exec(String(body.variables.query));
            const gids = match ? world.ordersBySourceIdentifier.get(match[1]) ?? [] : [];
            return jsonResponse({ data: { orders: {
                        nodes: gids.map((id) => ({
                            id, tags: [], sourceIdentifier: world.shopifySourceEchoOverride ?? match[1],
                        })),
                        pageInfo: { hasNextPage: world.shopifyHasNextPage },
                    } } });
        }
        throw new Error(`unexpected Shopify operation: ${body.operationName}`);
    };
    const io = {
        stdout: (message) => world.stdout.push(message),
        stderr: (message) => world.stderr.push(message),
        setExitCode: (code) => world.exitCodes.push(code),
    };
    const openMigrationSpy = (() => {
        world.migrationOpenCalls += 1;
        throw new Error('shadow-poll must never open the migration store');
    });
    const openStateReaderSpy = (() => {
        world.stateReaderOpenCalls += 1;
        throw new Error('shadow-poll must never open the state reader');
    });
    world.run = async (argv) => {
        await buildOrderImportAdminProgram({
            openMigration: openMigrationSpy,
            openStateReader: openStateReaderSpy,
            createEbayAdapter: () => createEbayOrderReadAdapter({
                fetchImpl: ebayFetch,
                getAccessToken: async () => 'transient-ebay-test-token',
            }),
            createShopifyAdapter: () => createShopifyOrderAdapter({
                fetchImpl: shopifyFetch,
                getAccessToken: async () => 'shopify-offline-test-token',
            }),
            now: () => new Date(NOW_UTC),
            io,
        }).parseAsync(argv, { from: 'user' });
    };
    return world;
}
function shadowArgv(extra = [], maxOrders = '10', lookbackHours = '24') {
    return ['shadow-poll', '--max-orders', maxOrders, '--lookback-hours', lookbackHours, ...extra];
}
describe('shadow-poll (read-only shadow parity mode)', () => {
    it('observes matched and unmatched orders with zero writes and zero store access', async () => {
        const world = createWorld();
        world.ebayListOrders = [
            ebayOrderFixture(MATCHED_ORDER_ID, '2026-08-20T10:00:00.000Z'),
            ebayOrderFixture(UNMATCHED_ORDER_ID, '2026-08-20T11:00:00.000Z'),
        ];
        world.ordersBySourceIdentifier.set(MATCHED_ORDER_ID, [MATCHED_GID]);
        await world.run(shadowArgv());
        const report = world.lastStdout();
        expect(report).toEqual({
            command: 'shadow-poll',
            mode: 'read-only-shadow',
            windowHours: 24,
            observed: [
                {
                    ebayOrderId: MATCHED_ORDER_ID,
                    createdAtUtc: '2026-08-20T10:00:00.000Z',
                    lineItemSkus: [SKU],
                    shopifyMatch: {
                        found: true, orderName: MATCHED_GID, matchedBy: 'source_identifier',
                    },
                },
                {
                    ebayOrderId: UNMATCHED_ORDER_ID,
                    createdAtUtc: '2026-08-20T11:00:00.000Z',
                    lineItemSkus: [SKU],
                    shopifyMatch: { found: false, orderName: null },
                },
            ],
            summary: {
                observedCount: 2,
                matchedCount: 1,
                unmatchedCount: 1,
                blockedCount: 0,
                lookupFailedCount: 0,
                ambiguousCount: 0,
                unmatchedEbayOrderIds: [UNMATCHED_ORDER_ID],
            },
            externalWritesPerformed: 0,
        });
        expect(world.exitCodes).toEqual([]);
        // The eBay filter is the lookback window (now - 24h), not a watermark.
        expect(world.ebayUrls[0]).toContain('filter=creationdate:%5B2026-08-19T12:00:00.000Z..%5D');
        expect(world.ebayUrls[0]).toContain('limit=10');
        // Shopify saw ONLY the two exact read-only identity lookups — no preflight or mutation.
        expect(new Set(world.shopifyOperations)).toEqual(new Set([
            'OrderImportOrdersBySourceIdentifier', 'OrderImportOrdersByTag',
        ]));
        // The migration store and its reader were never opened.
        expect(world.migrationOpenCalls).toBe(0);
        expect(world.stateReaderOpenCalls).toBe(0);
    });
    it('emits no buyer PII byte even though the eBay fixtures contain it', async () => {
        const world = createWorld();
        world.ebayListOrders = [
            ebayOrderFixture(MATCHED_ORDER_ID, '2026-08-20T10:00:00.000Z'),
            ebayOrderFixture(UNMATCHED_ORDER_ID, '2026-08-20T11:00:00.000Z'),
        ];
        world.ordersByTag.set(`eBay-${MATCHED_ORDER_ID}`, [MATCHED_GID]);
        const reportFile = path.join(makeRoot(), 'shadow-report.json');
        await world.run(shadowArgv(['--report-file', reportFile]));
        expect(world.lastStdout()).toMatchObject({ command: 'shadow-poll' });
        const reportBytes = fs.readFileSync(reportFile, 'utf8');
        for (const pii of PII_STRINGS) {
            expect(world.allEmitted()).not.toContain(pii);
            expect(reportBytes).not.toContain(pii);
        }
        // Even the non-PII title never leaves the allowed field set.
        expect(world.allEmitted()).not.toContain('Canon EF 35-70mm Lens');
        expect(reportBytes).not.toContain('Canon EF 35-70mm Lens');
    });
    it('reports a failed per-order Shopify lookup on that order and keeps the run', async () => {
        const world = createWorld();
        world.ebayListOrders = [ebayOrderFixture(MATCHED_ORDER_ID, '2026-08-20T10:00:00.000Z')];
        world.shopifyBehavior.mode = 'transport_error';
        await world.run(shadowArgv());
        const report = world.lastStdout();
        expect(report.observed).toEqual([{
                ebayOrderId: MATCHED_ORDER_ID,
                createdAtUtc: '2026-08-20T10:00:00.000Z',
                lineItemSkus: [SKU],
                shopifyMatch: { found: false, orderName: null, lookupFailed: true },
            }]);
        expect(report.summary).toEqual({
            observedCount: 1,
            matchedCount: 0,
            unmatchedCount: 1,
            blockedCount: 1,
            lookupFailedCount: 1,
            ambiguousCount: 0,
            unmatchedEbayOrderIds: [MATCHED_ORDER_ID],
        });
        expect(world.stderr).toEqual([]);
        expect(world.exitCodes).toEqual([1]);
    });
    it('fails a conflicting source-id/tag result closed as ambiguous', async () => {
        const world = createWorld();
        world.ebayListOrders = [ebayOrderFixture(MATCHED_ORDER_ID, '2026-08-20T10:00:00.000Z')];
        world.ordersBySourceIdentifier.set(MATCHED_ORDER_ID, [MATCHED_GID]);
        world.ordersByTag.set(`eBay-${MATCHED_ORDER_ID}`, ['gid://shopify/Order/8888']);
        await world.run(shadowArgv());
        expect(world.lastStdout()).toMatchObject({
            observed: [{
                    ebayOrderId: MATCHED_ORDER_ID,
                    shopifyMatch: { found: false, orderName: null, ambiguous: true },
                }],
            summary: { matchedCount: 0, unmatchedCount: 1 },
            externalWritesPerformed: 0,
        });
        expect(world.exitCodes).toEqual([1]);
    });
    it('blocks non-exact Shopify search echoes and unexpected pagination', async () => {
        for (const mode of ['nonexact', 'pagination']) {
            const world = createWorld();
            world.ebayListOrders = [
                ebayOrderFixture(MATCHED_ORDER_ID, '2026-08-20T10:00:00.000Z'),
            ];
            world.ordersBySourceIdentifier.set(MATCHED_ORDER_ID, [MATCHED_GID]);
            if (mode === 'nonexact')
                world.shopifySourceEchoOverride = UNMATCHED_ORDER_ID;
            if (mode === 'pagination')
                world.shopifyHasNextPage = true;
            await world.run(shadowArgv());
            expect(world.lastStdout()).toMatchObject({
                observed: [{ shopifyMatch: { found: false, lookupFailed: true } }],
                summary: { blockedCount: 1, lookupFailedCount: 1 },
            });
            expect(world.exitCodes).toEqual([1]);
        }
    });
    it('fails the whole run cleanly on an eBay read failure', async () => {
        const world = createWorld();
        world.ebayBehavior.mode = 'transport_error';
        await world.run(shadowArgv());
        expect(world.lastStderr()).toEqual({
            command: 'shadow-poll',
            status: 'denied',
            code: 'SHADOW_POLL_EBAY_READ_FAILED',
        });
        expect(world.exitCodes).toEqual([1]);
        expect(world.stdout).toEqual([]);
    });
    it('denies out-of-bounds or non-integer options before any provider call', async () => {
        const cases = [
            ['0', '24', 'SHADOW_POLL_MAX_ORDERS_INVALID'],
            ['51', '24', 'SHADOW_POLL_MAX_ORDERS_INVALID'],
            ['2.5', '24', 'SHADOW_POLL_MAX_ORDERS_INVALID'],
            ['abc', '24', 'SHADOW_POLL_MAX_ORDERS_INVALID'],
            ['10', '0', 'SHADOW_POLL_LOOKBACK_INVALID'],
            ['10', '169', 'SHADOW_POLL_LOOKBACK_INVALID'],
            ['10', '1.5', 'SHADOW_POLL_LOOKBACK_INVALID'],
            ['10', 'abc', 'SHADOW_POLL_LOOKBACK_INVALID'],
        ];
        for (const [maxOrders, lookbackHours, code] of cases) {
            const world = createWorld();
            await world.run(shadowArgv([], maxOrders, lookbackHours));
            expect(world.lastStderr()).toMatchObject({ command: 'shadow-poll', code });
            expect(world.exitCodes).toEqual([1]);
            expect(world.ebayUrls).toEqual([]);
            expect(world.shopifyOperations).toEqual([]);
        }
        // The boundary values themselves are accepted.
        const world = createWorld();
        await world.run(shadowArgv([], '1', '168'));
        expect(world.lastStdout()).toMatchObject({ command: 'shadow-poll', windowHours: 168 });
    });
    it('writes the report only to a fresh absolute path, mode 0600, identical to stdout', async () => {
        const world = createWorld();
        world.ebayListOrders = [ebayOrderFixture(MATCHED_ORDER_ID, '2026-08-20T10:00:00.000Z')];
        world.ordersByTag.set(`eBay-${MATCHED_ORDER_ID}`, [MATCHED_GID]);
        const reportFile = path.join(makeRoot(), 'shadow-report.json');
        await world.run(shadowArgv(['--report-file', reportFile]));
        const written = fs.readFileSync(reportFile, 'utf8');
        expect(written).toBe(`${world.stdout[world.stdout.length - 1]}\n`);
        expect(fs.statSync(reportFile).mode & 0o777).toBe(0o600);
        expect(JSON.parse(written)).toMatchObject({
            command: 'shadow-poll',
            mode: 'read-only-shadow',
            externalWritesPerformed: 0,
        });
        expect(world.migrationOpenCalls).toBe(0);
        expect(world.stateReaderOpenCalls).toBe(0);
    });
    it('denies a relative report path before any provider call', async () => {
        const world = createWorld();
        await world.run(shadowArgv(['--report-file', 'relative/report.json']));
        expect(world.lastStderr()).toMatchObject({ code: 'SHADOW_POLL_REPORT_PATH_INVALID' });
        expect(world.exitCodes).toEqual([1]);
        expect(world.ebayUrls).toEqual([]);
    });
    it('refuses to overwrite an existing report file or follow a symlink', async () => {
        const root = makeRoot();
        const existing = path.join(root, 'existing.json');
        fs.writeFileSync(existing, '{"previous":true}');
        const world = createWorld();
        await world.run(shadowArgv(['--report-file', existing]));
        expect(world.lastStderr()).toMatchObject({ code: 'SHADOW_POLL_REPORT_EXISTS' });
        expect(world.exitCodes).toEqual([1]);
        expect(world.ebayUrls).toEqual([]);
        expect(fs.readFileSync(existing, 'utf8')).toBe('{"previous":true}');
        // A symlink at the path — even a dangling one — is refused, never followed.
        const linked = path.join(root, 'linked.json');
        fs.symlinkSync(path.join(root, 'symlink-target.json'), linked);
        const symlinkWorld = createWorld();
        await symlinkWorld.run(shadowArgv(['--report-file', linked]));
        expect(symlinkWorld.lastStderr()).toMatchObject({ code: 'SHADOW_POLL_REPORT_EXISTS' });
        expect(fs.existsSync(path.join(root, 'symlink-target.json'))).toBe(false);
    });
    it('denies a report path whose parent directory does not exist', async () => {
        const world = createWorld();
        await world.run(shadowArgv(['--report-file', path.join(makeRoot(), 'missing-parent', 'report.json')]));
        expect(world.lastStderr()).toMatchObject({ code: 'SHADOW_POLL_REPORT_PARENT_MISSING' });
        expect(world.exitCodes).toEqual([1]);
        expect(world.ebayUrls).toEqual([]);
    });
    it('never opens the migration store on any path, including failures', async () => {
        const world = createWorld();
        world.ebayBehavior.mode = 'transport_error';
        await world.run(shadowArgv());
        await world.run(shadowArgv([], '0', '24'));
        await world.run(shadowArgv(['--report-file', 'relative.json']));
        expect(world.migrationOpenCalls).toBe(0);
        expect(world.stateReaderOpenCalls).toBe(0);
        // No shadow-poll invocation ever set a success/other exit path that
        // touched the store: every recorded failure is a SHADOW_POLL_* code.
        for (const line of world.stderr) {
            expect(JSON.parse(line).code).toMatch(/^SHADOW_POLL_/);
        }
    });
});
