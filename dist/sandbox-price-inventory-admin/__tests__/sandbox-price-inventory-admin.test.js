import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSandboxBulkUpdateBody } from '../../sandbox-listing-canary-admin/adapter.js';
import { readSandboxManifest, validateTarget } from '../../sandbox-listing-canary-admin/manifest.js';
import { sha256Digest } from '../../migration-store/index.js';
import { SANDBOX_ALIGNMENT_SCOPE, SANDBOX_ALIGNMENT_SCOPE_DIGEST, digest, } from '../contracts.js';
import { runSandboxPriceInventoryAdmin } from '../program.js';
import { openSandboxAlignmentStore } from '../store.js';
const dirs = [];
afterEach(() => {
    process.exitCode = undefined;
    for (const directory of dirs.splice(0))
        rmSync(directory, { recursive: true, force: true });
});
function world(options = {}) {
    const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sandbox-align-')));
    chmodSync(directory, 0o700);
    dirs.push(directory);
    const store = path.join(directory, 'control.sqlite');
    const listingManifestFile = path.join(directory, 'listing-manifest.json');
    const shopifyEvidenceDigest = sha256Digest('reviewed-shopify-evidence');
    const listingManifest = Object.freeze({
        schemaVersion: 1, environment: 'sandbox', marketplaceId: 'EBAY_US',
        target: Object.freeze({ storeDomain: 'usedcameragear.myshopify.com',
            productGid: 'gid://shopify/Product/10345525412131',
            variantGid: 'gid://shopify/ProductVariant/55519196250403', sku: 'PIPELINE-TEST-20260826',
            shopifyEvidenceDigest }),
        listing: Object.freeze({ title: 'PRODUCT PIPELINE SANDBOX TEST - DO NOT BUY Pipeline Test',
            description: 'PRODUCT PIPELINE SANDBOX TEST - DO NOT BUY', imageUrls: ['https://i.ebayimg.com/test.jpg'],
            categoryId: '31388', condition: 'USED_EXCELLENT', conditionDescription: 'Fictional Sandbox item',
            quantity: 1, price: Object.freeze({ currency: 'USD', value: '1.00' }),
            merchantLocationKey: 'pp-test-lane', fulfillmentPolicyId: 'f', paymentPolicyId: 'p', returnPolicyId: 'r' }),
    });
    writeFileSync(listingManifestFile, JSON.stringify(listingManifest), { mode: 0o600 });
    chmodSync(listingManifestFile, 0o600);
    const createTarget = validateTarget({ storeDomain: 'usedcameragear.myshopify.com',
        productGid: 'gid://shopify/Product/10345525412131',
        variantGid: 'gid://shopify/ProductVariant/55519196250403', sku: 'PIPELINE-TEST-20260826',
        shopifyEvidenceDigest });
    const listingProvenanceDigest = readSandboxManifest(listingManifestFile, createTarget).digest;
    const listingArgs = ['--listing-provenance-digest', listingProvenanceDigest,
        '--listing-manifest-file', listingManifestFile, '--shopify-evidence-digest', shopifyEvidenceDigest];
    const output = [];
    const exitCodes = [];
    const io = {
        stdout: (value) => output.push(value), stderr: (value) => output.push(value),
        setExitCode: (value) => exitCodes.push(value),
    };
    const source = Object.freeze({
        storeDomain: 'usedcameragear.myshopify.com', shopId: 'gid://shopify/Shop/86254518563',
        appClientId: '2db0555e4848a8264383dc0edfcfb8fe',
        scopes: Object.freeze(['read_fulfillments', 'read_inventory', 'read_orders', 'read_products']),
        productId: 'gid://shopify/Product/10345525412131',
        variantId: 'gid://shopify/ProductVariant/55519196250403', title: 'Pipeline Test',
        status: 'ACTIVE', tags: Object.freeze(['product-pipeline-test-lane']), publishedAt: null,
        sku: 'PIPELINE-TEST-20260826', currency: 'USD', price: '99.99', quantity: 1,
    });
    let ebay = Object.freeze({
        sellerId: 'testuser_ppcanary-3c55629b', registrationMarketplaceId: 'EBAY_US',
        sku: 'PIPELINE-TEST-20260826', offerId: '123456789', listingId: '987654321',
        marketplaceId: 'EBAY_US', merchantLocationKey: 'pp-test-lane', format: 'FIXED_PRICE',
        listingDuration: 'GTC', status: 'PUBLISHED', listingStatus: 'ACTIVE',
        itemQuantity: 1, offerQuantity: 1, tradingQuantity: 1,
        price: Object.freeze({ currency: 'USD', value: '1.00' }),
        tradingPrice: Object.freeze({ currency: 'USD', value: '1.00' }),
    });
    let writes = 0;
    const adapter = Object.freeze({
        readShopifySource: async () => source,
        readEbayState: async () => ebay,
        updatePrice: async (_target, price) => {
            writes += 1;
            if (!options.throwWithoutWrite)
                ebay = Object.freeze({ ...ebay, price: Object.freeze(price),
                    tradingPrice: Object.freeze(price) });
            if (options.throwAfterWrite || options.throwWithoutWrite)
                throw new Error('redacted');
        },
        updateQuantity: async (_target, quantity) => {
            writes += 1;
            if (!options.throwWithoutWrite)
                ebay = Object.freeze({ ...ebay, itemQuantity: quantity,
                    offerQuantity: quantity, tradingQuantity: quantity });
            if (options.throwAfterWrite || options.throwWithoutWrite)
                throw new Error('redacted');
        },
    });
    let ms = Date.parse('2026-08-26T12:00:00.000Z');
    const dependencies = { createAdapters: () => adapter, io, now: () => new Date(ms += 1) };
    const run = async (...args) => {
        output.length = 0;
        await runSandboxPriceInventoryAdmin(args, dependencies);
        return JSON.parse(output.at(-1));
    };
    const target = ['--store', store, '--sku', SANDBOX_ALIGNMENT_SCOPE.ebay.sku,
        '--offer-id', '123456789', '--listing-id', '987654321'];
    return { store, run, target, listingArgs, source, adapter, get ebay() { return ebay; },
        advance: (deltaMs) => { ms += deltaMs; },
        setEbay: (next) => { ebay = next; }, get writes() { return writes; } };
}
async function initialize(candidate) {
    const result = await candidate.run('init', '--store', candidate.store, '--confirm-scope', SANDBOX_ALIGNMENT_SCOPE_DIGEST);
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'initialized', auditValid: true, externalWritesPerformed: 0 });
}
const approvalArgs = (approved) => ['--manifest-digest', approved.manifestDigest,
    '--approval-token', approved.approvalToken, '--approval-digest', approved.approvalDigest];
async function preflightAndApprove(candidate, action) {
    const preflight = await candidate.run('preflight', ...candidate.target, '--action', action, ...candidate.listingArgs);
    expect(preflight).toMatchObject({ status: 'approval-required', action, externalWritesPerformed: 0 });
    const manifestDigest = preflight.manifestDigest;
    const approve = await candidate.run('approve', '--store', candidate.store, '--manifest-digest', manifestDigest, '--confirm-action', action);
    expect(approve).toMatchObject({ status: 'approved', manifestDigest, externalWritesPerformed: 0 });
    return Object.freeze({ manifestDigest, approvalToken: approve.approvalToken,
        approvalDigest: approve.approvalDigest });
}
describe('sandbox price/inventory ceremony', () => {
    it('runs the three separately approved exact actions in the reviewed order', async () => {
        const candidate = world();
        await initialize(candidate);
        const price = await preflightAndApprove(candidate, 'price-align');
        expect(await candidate.run('dispatch', ...candidate.target, ...approvalArgs(price)))
            .toMatchObject({ status: 'reconciled', effect: 'effect_observed', externalWritesPerformed: 1 });
        expect(candidate.ebay.price.value).toBe('99.99');
        const seed = await preflightAndApprove(candidate, 'quantity-seed');
        expect(await candidate.run('dispatch', ...candidate.target, ...approvalArgs(seed)))
            .toMatchObject({ status: 'reconciled', effect: 'effect_observed', externalWritesPerformed: 1 });
        expect(candidate.ebay.itemQuantity).toBe(2);
        const align = await preflightAndApprove(candidate, 'quantity-align');
        expect(await candidate.run('dispatch', ...candidate.target, ...approvalArgs(align)))
            .toMatchObject({ status: 'reconciled', effect: 'effect_observed', externalWritesPerformed: 1 });
        expect(candidate.ebay.itemQuantity).toBe(1);
        expect(candidate.writes).toBe(3);
        expect(await candidate.run('verify', '--store', candidate.store))
            .toMatchObject({ status: 'verified', intentCount: 3, auditValid: true, externalWritesPerformed: 0 });
    });
    it('resolves a response-lost write by observation and never retries it', async () => {
        const candidate = world({ throwAfterWrite: true });
        await initialize(candidate);
        const manifest = await preflightAndApprove(candidate, 'price-align');
        expect(await candidate.run('dispatch', ...candidate.target, '--manifest-digest', manifest.manifestDigest, '--approval-token', `${manifest.approvalToken}-wrong`, '--approval-digest', manifest.approvalDigest))
            .toMatchObject({ status: 'denied', code: 'DISPATCH_APPROVAL_DENIED', externalWritesPerformed: 0 });
        expect(await candidate.run('dispatch', ...candidate.target, ...approvalArgs(manifest)))
            .toMatchObject({ status: 'reconciled', providerOutcome: 'unknown', effect: 'effect_observed', externalWritesPerformed: 1 });
        expect(candidate.writes).toBe(1);
        expect(await candidate.run('dispatch', ...candidate.target, ...approvalArgs(manifest)))
            .toMatchObject({ status: 'denied', code: 'ATTEMPT_ALREADY_RESOLVED', externalWritesPerformed: 0 });
        expect(candidate.writes).toBe(1);
    });
    it('leaves an unknown absent outcome unresolved and permits only zero-write reconciliation', async () => {
        const candidate = world({ throwWithoutWrite: true });
        await initialize(candidate);
        const manifest = await preflightAndApprove(candidate, 'price-align');
        expect(await candidate.run('dispatch', ...candidate.target, ...approvalArgs(manifest)))
            .toMatchObject({ status: 'unresolved', providerOutcome: 'unknown', effect: 'effect_absent', externalWritesPerformed: 1 });
        expect(candidate.writes).toBe(1);
        candidate.setEbay(Object.freeze({ ...candidate.ebay,
            price: Object.freeze({ currency: 'USD', value: '99.99' }),
            tradingPrice: Object.freeze({ currency: 'USD', value: '99.99' }) }));
        expect(await candidate.run('reconcile', ...candidate.target, '--manifest-digest', manifest.manifestDigest))
            .toMatchObject({ status: 'reconciled', effect: 'effect_observed', externalWritesPerformed: 0 });
        expect(candidate.writes).toBe(1);
    });
    it('recovers a crash after approval consumption without redispatch', async () => {
        const candidate = world();
        await initialize(candidate);
        const approved = await preflightAndApprove(candidate, 'price-align');
        const store = openSandboxAlignmentStore(candidate.store);
        store.beginDispatch(approved.manifestDigest, approved.approvalToken, approved.approvalDigest, '2026-08-26T12:01:00.000Z');
        store.close();
        expect(await candidate.run('reconcile', ...candidate.target, '--manifest-digest', approved.manifestDigest))
            .toMatchObject({ status: 'unresolved', effect: 'effect_absent', externalWritesPerformed: 0 });
        candidate.setEbay(Object.freeze({ ...candidate.ebay,
            price: Object.freeze({ currency: 'USD', value: '99.99' }),
            tradingPrice: Object.freeze({ currency: 'USD', value: '99.99' }) }));
        expect(await candidate.run('reconcile', ...candidate.target, '--manifest-digest', approved.manifestDigest))
            .toMatchObject({ status: 'reconciled', effect: 'effect_observed', externalWritesPerformed: 0 });
        expect(candidate.writes).toBe(0);
    });
    it('denies wrong source, account, target, and action ordering before a write', async () => {
        const candidate = world();
        await initialize(candidate);
        const wrongTarget = [...candidate.target];
        wrongTarget[wrongTarget.indexOf('--sku') + 1] = 'OTHER';
        expect(await candidate.run('preflight', ...wrongTarget, '--action', 'price-align', ...candidate.listingArgs)).toMatchObject({ status: 'denied', code: 'EXACT_TARGET_INVALID' });
        const wrongProvenance = [...candidate.listingArgs];
        wrongProvenance[wrongProvenance.indexOf('--listing-provenance-digest') + 1] = digest('wrong-provenance');
        expect(await candidate.run('preflight', ...candidate.target, '--action', 'price-align', ...wrongProvenance)).toMatchObject({ status: 'denied', code: 'LISTING_PROVENANCE_MISMATCH' });
        expect(await candidate.run('preflight', ...candidate.target, '--action', 'quantity-seed', ...candidate.listingArgs)).toMatchObject({ status: 'denied', code: 'ACTION_SEQUENCE_INVALID' });
        candidate.setEbay(Object.freeze({ ...candidate.ebay, sellerId: 'production-seller' }));
        expect(await candidate.run('preflight', ...candidate.target, '--action', 'price-align', ...candidate.listingArgs)).toMatchObject({ status: 'denied', code: 'EBAY_SANDBOX_STATE_MISMATCH' });
        expect(candidate.writes).toBe(0);
    });
    it('expires approval before provider access and rejects a wrong store scope', async () => {
        const candidate = world();
        expect(await candidate.run('init', '--store', candidate.store, '--confirm-scope', digest('wrong')))
            .toMatchObject({ status: 'denied', code: 'STORE_SCOPE_MISMATCH', externalWritesPerformed: 0 });
        const fresh = world();
        await initialize(fresh);
        const manifest = await preflightAndApprove(fresh, 'price-align');
        fresh.advance(11 * 60_000);
        expect(await fresh.run('dispatch', ...fresh.target, ...approvalArgs(manifest)))
            .toMatchObject({ status: 'denied', code: 'DISPATCH_APPROVAL_DENIED', externalWritesPerformed: 0 });
        expect(fresh.writes).toBe(0);
    });
    it('detects manifest tampering independently of SQLite integrity', async () => {
        const candidate = world();
        await initialize(candidate);
        await candidate.run('preflight', ...candidate.target, '--action', 'price-align', ...candidate.listingArgs);
        const db = new Database(candidate.store);
        db.prepare(`UPDATE intents SET manifest_json = '{}'`).run();
        db.close();
        expect(await candidate.run('verify', '--store', candidate.store))
            .toMatchObject({ status: 'denied', code: 'STORE_AUDIT_INVALID', externalWritesPerformed: 0 });
        const forged = world();
        await initialize(forged);
        await forged.run('preflight', ...forged.target, '--action', 'price-align', ...forged.listingArgs);
        const forgedDb = new Database(forged.store);
        forgedDb.prepare(`UPDATE intents SET status = 'approved'`).run();
        forgedDb.close();
        expect(await forged.run('verify', '--store', forged.store))
            .toMatchObject({ status: 'denied', code: 'STORE_AUDIT_INVALID', externalWritesPerformed: 0 });
    });
});
describe('sandbox bulk update body', () => {
    it('has exactly one price-only or quantity-only request', () => {
        const price = JSON.parse(buildSandboxBulkUpdateBody({ field: 'price', sku: SANDBOX_ALIGNMENT_SCOPE.ebay.sku,
            offerId: '123', price: { currency: 'USD', value: '99.99' } }));
        expect(JSON.stringify(price)).not.toMatch(/quantity|availab/i);
        const quantity = JSON.parse(buildSandboxBulkUpdateBody({ field: 'quantity', sku: SANDBOX_ALIGNMENT_SCOPE.ebay.sku,
            offerId: '123', quantity: 2 }));
        expect(JSON.stringify(quantity)).not.toMatch(/price/i);
    });
});
