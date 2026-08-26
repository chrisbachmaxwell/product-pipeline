import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createSandboxAdapter } from '../adapter.js';
import { readSandboxManifest, SANDBOX_API_ORIGIN, SANDBOX_IDENTITY_ORIGIN } from '../manifest.js';
import { buildSandboxListingCanaryProgram } from '../program.js';
const NOW = new Date('2026-08-26T18:00:00.000Z');
const D = `sha256:${'a'.repeat(64)}`;
const target = { storeDomain: 'example.myshopify.com', productGid: 'gid://shopify/Product/1001', variantGid: 'gid://shopify/ProductVariant/2002', sku: 'SANDBOX-CANARY-1', shopifyEvidenceDigest: D };
const roots = [];
afterEach(() => { for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true }); });
function manifest() { return { schemaVersion: 1, environment: 'sandbox', marketplaceId: 'EBAY_US', target, listing: { title: 'PRODUCT PIPELINE SANDBOX TEST - DO NOT BUY camera', description: 'PRODUCT PIPELINE SANDBOX TEST - DO NOT BUY', imageUrls: ['https://cdn.shopify.com/s/files/1/camera.jpg'], categoryId: '31388', condition: 'USED_EXCELLENT', conditionDescription: 'Sandbox fixture', quantity: 1, price: { currency: 'USD', value: '1.00' }, merchantLocationKey: 'sandbox-location', fulfillmentPolicyId: 'sandbox-fulfillment', paymentPolicyId: 'sandbox-payment', returnPolicyId: 'sandbox-return' } }; }
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-canary-')); roots.push(root); fs.chmodSync(root, 0o700); const file = path.join(root, 'manifest.json'); fs.writeFileSync(file, JSON.stringify(manifest()), { mode: 0o600 }); return { root, file, state: path.join(root, 'sandbox-canary.sqlite') }; }
function packet() { return Readable.from([JSON.stringify({ accessToken: 'sandbox-token-value-123456', sellerId: 'TESTUSER_SAFE_FIXTURE', scopes: ['https://api.ebay.com/oauth/api_scope/commerce.identity.readonly', 'https://api.ebay.com/oauth/api_scope/sell.inventory'], issuedAtUtc: '2026-08-26T17:59:00.000Z', expiresAtUtc: '2026-08-26T19:00:00.000Z' })]); }
describe('sandbox canary manifest and endpoint boundary', () => {
    it('requires an exact private 0600 manifest, fixed $1 marker, and credential-free approved image URL', () => { const f = fixture(); const parsed = readSandboxManifest(f.file, target); expect(parsed.digest).toMatch(/^sha256:[a-f0-9]{64}$/); const bad = manifest(); bad.listing.price.value = '9.99'; fs.writeFileSync(f.file, JSON.stringify(bad), { mode: 0o600 }); expect(() => readSandboxManifest(f.file, target)).toThrowError(/denied/); bad.listing.price.value = '1.00'; bad.listing.imageUrls = ['https://cdn.shopify.com/camera.jpg?token=secret']; fs.writeFileSync(f.file, JSON.stringify(bad), { mode: 0o600 }); expect(() => readSandboxManifest(f.file, target)).toThrowError(/denied/); });
    it('rejects a 200 inventory echo for another SKU and unsupported offer status', async () => { const identity = { userId: 'TESTUSER_SAFE_FIXTURE', registrationMarketplaceId: 'EBAY_US' }; const wrongItem = createSandboxAdapter({ token: 'sandbox-token-value-123456', expectedSellerId: 'TESTUSER_SAFE_FIXTURE', now: () => NOW, fetchImpl: async (input) => String(input).startsWith(SANDBOX_IDENTITY_ORIGIN) ? new Response(JSON.stringify(identity), { status: 200 }) : new Response(JSON.stringify({ sku: 'OTHER-SKU' }), { status: 200 }) }); await wrongItem.verifyIdentity(); await expect(wrongItem.snapshot(target.sku)).rejects.toMatchObject({ code: 'AMBIGUOUS_REMOTE_STATE' }); const invalidOffer = createSandboxAdapter({ token: 'sandbox-token-value-123456', expectedSellerId: 'TESTUSER_SAFE_FIXTURE', now: () => NOW, fetchImpl: async (input) => { const url = String(input); if (url.startsWith(SANDBOX_IDENTITY_ORIGIN))
            return new Response(JSON.stringify(identity), { status: 200 }); if (url.includes('/inventory_item/'))
            return new Response('', { status: 404 }); if (url.includes('/offer?'))
            return new Response(JSON.stringify({ total: 1, offers: [{ offerId: 'O1', sku: target.sku, marketplaceId: 'EBAY_US', status: 'UNKNOWN' }] }), { status: 200 }); return new Response('', { status: 500 }); } }); await invalidOffer.verifyIdentity(); await expect(invalidOffer.snapshot(target.sku)).rejects.toMatchObject({ code: 'AMBIGUOUS_REMOTE_STATE' }); });
    it('constructs only immutable Sandbox URLs and rejects ambiguous pagination', async () => { const calls = []; const adapter = createSandboxAdapter({ token: 'sandbox-token-value-123456', expectedSellerId: 'TESTUSER_SAFE_FIXTURE', now: () => NOW, fetchImpl: async (input) => { const url = String(input); calls.push(url); if (url.startsWith(SANDBOX_IDENTITY_ORIGIN))
            return new Response(JSON.stringify({ userId: 'TESTUSER_SAFE_FIXTURE', registrationMarketplaceId: 'EBAY_US' }), { status: 200 }); if (url.includes('/inventory_item/'))
            return new Response('', { status: 404 }); if (url.includes('/offer?'))
            return new Response(JSON.stringify({ total: 26, offers: [] }), { status: 200 }); return new Response('<GetSellerListResponse><Ack>Success</Ack><HasMoreItems>false</HasMoreItems><PaginationResult><TotalNumberOfEntries>0</TotalNumberOfEntries></PaginationResult></GetSellerListResponse>', { status: 200 }); } }); await adapter.verifyIdentity(); await expect(adapter.snapshot(target.sku)).rejects.toMatchObject({ code: 'AMBIGUOUS_REMOTE_STATE' }); expect(calls.every((url) => url.startsWith(SANDBOX_API_ORIGIN) || url.startsWith(SANDBOX_IDENTITY_ORIGIN))).toBe(true); expect(calls.join(' ')).not.toContain('https://api.ebay.com/'); });
    it('has no server runtime import or order path', () => { const root = path.resolve(import.meta.dirname, '../..'); const serverFiles = fs.readdirSync(path.join(root, 'server'), { recursive: true }).filter(v => String(v).endsWith('.ts')); for (const entry of serverFiles) {
        const source = fs.readFileSync(path.join(root, 'server', String(entry)), 'utf8');
        expect(source).not.toContain('sandbox-listing-canary-admin');
    } const slice = fs.readdirSync(path.resolve(import.meta.dirname, '..')).filter(v => v.endsWith('.ts')).map(v => fs.readFileSync(path.resolve(import.meta.dirname, '..', v), 'utf8')).join('\n'); expect(slice).not.toMatch(/order-import|syncOrders|createShopifyOrder|MarketplaceConnect/); });
});
describe('standalone ceremony', () => {
    it('initializes separate state, contains partial outcomes, reconciles, cleans up, and denies replay', async () => {
        const f = fixture();
        let state = 'absent';
        let failPublishOnce = true;
        let failDeleteOfferOnce = true;
        const calls = [];
        const offerId = 'OFFER-100';
        const listingId = '123456789012';
        const fetchImpl = async (input, init) => {
            const url = String(input);
            const method = init?.method ?? 'GET';
            calls.push(`${method} ${url}`);
            if (url.startsWith(SANDBOX_IDENTITY_ORIGIN))
                return new Response(JSON.stringify({ userId: 'TESTUSER_SAFE_FIXTURE', registrationMarketplaceId: 'EBAY_US' }), { status: 200 });
            if (url.endsWith('/ws/api.dll')) {
                const count = state === 'published' ? 1 : 0;
                const sku = count ? `<Item><SKU>${target.sku}</SKU></Item>` : '';
                return new Response(`<GetSellerListResponse><Ack>Success</Ack><HasMoreItems>false</HasMoreItems><PaginationResult><TotalNumberOfEntries>${count}</TotalNumberOfEntries></PaginationResult>${sku}</GetSellerListResponse>`, { status: 200 });
            }
            if (url.includes('/inventory_item/')) {
                if (method === 'GET')
                    return new Response(state === 'absent' ? '' : JSON.stringify({ sku: target.sku }), { status: state === 'absent' ? 404 : 200 });
                if (method === 'PUT') {
                    state = 'item';
                    return new Response(null, { status: 204 });
                }
                if (method === 'DELETE') {
                    state = 'absent';
                    return new Response(null, { status: 204 });
                }
            }
            if (url.endsWith('/offer') && method === 'POST') {
                state = 'offer';
                return new Response(JSON.stringify({ offerId }), { status: 201 });
            }
            if (url.includes('/offer?')) {
                const offers = state === 'offer' || state === 'published' ? [{ offerId, sku: target.sku, marketplaceId: 'EBAY_US', status: state === 'published' ? 'PUBLISHED' : 'UNPUBLISHED', ...(state === 'published' ? { listing: { listingId } } : {}) }] : [];
                return new Response(JSON.stringify({ total: offers.length, offers }), { status: 200 });
            }
            if (url.endsWith(`/offer/${offerId}/publish`)) {
                if (failPublishOnce) {
                    failPublishOnce = false;
                    return new Response('', { status: 500 });
                }
                state = 'published';
                return new Response(JSON.stringify({ listingId }), { status: 200 });
            }
            if (url.endsWith(`/offer/${offerId}/withdraw`)) {
                state = 'offer';
                return new Response(null, { status: 204 });
            }
            if (url.endsWith(`/offer/${offerId}`) && method === 'DELETE') {
                if (failDeleteOfferOnce) {
                    failDeleteOfferOnce = false;
                    return new Response('', { status: 500 });
                }
                state = 'item';
                return new Response(null, { status: 204 });
            }
            return new Response('', { status: 500 });
        };
        const base = ['--store-domain', target.storeDomain, '--product-gid', target.productGid, '--variant-gid', target.variantGid, '--sku', target.sku, '--shopify-evidence-digest', D, '--manifest-file', f.file];
        let sequence = 0;
        let currentNow = NOW;
        async function execute(command, args) { const stdout = []; const stderr = []; const exits = []; const io = { stdout: m => stdout.push(m), stderr: m => stderr.push(m), setExitCode: c => exits.push(c) }; await buildSandboxListingCanaryProgram({ io, stdin: packet(), fetchImpl, now: () => currentNow, uuid: () => `id${++sequence}` }).parseAsync(['node', 'cli', command, ...base, ...args]); return { stdout, stderr, exits, json: stdout[0] ? JSON.parse(stdout[0]) : null }; }
        const initialized = await execute('init-store', ['--state', f.state, '--evidence-digest', D]);
        expect(initialized.stderr).toEqual([]);
        expect(initialized).toMatchObject({ json: { status: 'initialized' } });
        expect(fs.statSync(f.state).mode & 0o077).toBe(0);
        const pre = await execute('preflight', []);
        expect(pre.json.status).toBe('ready');
        expect(pre.exits).toEqual([2]);
        const beforeDispatch = calls.length;
        const writesBeforeApproval = calls.filter(v => /^(PUT|POST|DELETE) /.test(v) && !v.includes('/ws/api.dll')).length;
        const unapproved = await execute('dispatch-create', ['--state', f.state, '--manifest-digest', pre.json.manifestDigest, '--approval-token', 'sandbox-approval:not-recorded', '--approval-digest', D, '--intent-key', D]);
        expect(unapproved.stderr[0]).toContain('APPROVAL');
        expect(calls.filter(v => /^(PUT|POST|DELETE) /.test(v) && !v.includes('/ws/api.dll'))).toHaveLength(writesBeforeApproval);
        const approved = await execute('approve-create', ['--state', f.state, '--manifest-digest', pre.json.manifestDigest]);
        expect(approved.json.status).toBe('approved');
        const beforeWrong = calls.filter(v => /^(PUT|POST|DELETE) /.test(v) && !v.includes('/ws/api.dll')).length;
        const wrongIntent = await execute('dispatch-create', ['--state', f.state, '--manifest-digest', pre.json.manifestDigest, '--approval-token', approved.json.approvalToken, '--approval-digest', approved.json.approvalDigest, '--intent-key', D]);
        expect(wrongIntent.stderr[0]).toContain('MIGRATION_STORE_');
        expect(calls.filter(v => /^(PUT|POST|DELETE) /.test(v) && !v.includes('/ws/api.dll'))).toHaveLength(beforeWrong);
        currentNow = new Date('2026-08-26T18:11:00.000Z');
        const expired = await execute('dispatch-create', ['--state', f.state, '--manifest-digest', pre.json.manifestDigest, '--approval-token', approved.json.approvalToken, '--approval-digest', approved.json.approvalDigest, '--intent-key', approved.json.intentKey]);
        expect(expired.stderr[0]).toContain('APPROVAL');
        expect(calls.filter(v => /^(PUT|POST|DELETE) /.test(v) && !v.includes('/ws/api.dll'))).toHaveLength(beforeWrong);
        currentNow = NOW;
        const created = await execute('dispatch-create', ['--state', f.state, '--manifest-digest', pre.json.manifestDigest, '--approval-token', approved.json.approvalToken, '--approval-digest', approved.json.approvalDigest, '--intent-key', approved.json.intentKey]);
        expect(created.json.status).toBe('dispatched-unresolved');
        expect(created.json.offerId).toBe(offerId);
        expect(state).toBe('offer');
        const writesAfterUnknown = calls.filter(v => /^(PUT|POST|DELETE) /.test(v) && !v.includes('/ws/api.dll')).length;
        const replay = await execute('dispatch-create', ['--state', f.state, '--manifest-digest', pre.json.manifestDigest, '--approval-token', approved.json.approvalToken, '--approval-digest', approved.json.approvalDigest, '--intent-key', approved.json.intentKey]);
        expect(replay.stderr[0]).toContain('TARGET_NOT_ABSENT');
        expect(calls.filter(v => /^(PUT|POST|DELETE) /.test(v) && !v.includes('/ws/api.dll'))).toHaveLength(writesAfterUnknown);
        state = 'published';
        const recovered = await execute('reconcile-create', ['--state', f.state, '--manifest-digest', pre.json.manifestDigest, '--offer-id', offerId, '--listing-id', listingId, '--job-id', created.json.jobId, '--attempt-id', created.json.attemptId, '--intent-key', created.json.intentKey]);
        expect(recovered.json.status).toBe('reconciled');
        const auditBeforeReplay = (await execute('verify-state', ['--state', f.state])).json.audit.recordCount;
        const terminalReplay = await execute('reconcile-create', ['--state', f.state, '--manifest-digest', pre.json.manifestDigest, '--offer-id', offerId, '--listing-id', listingId, '--job-id', created.json.jobId, '--attempt-id', created.json.attemptId, '--intent-key', created.json.intentKey]);
        expect(terminalReplay.stderr[0]).toContain('RECONCILIATION_BINDING_INVALID');
        expect((await execute('verify-state', ['--state', f.state])).json.audit.recordCount).toBe(auditBeforeReplay);
        const dispatchCalls = calls.slice(beforeDispatch);
        expect(dispatchCalls.findIndex(v => v.startsWith('GET '))).toBeLessThan(dispatchCalls.findIndex(v => v.startsWith('PUT ')));
        const cleanup = await execute('preflight-cleanup', ['--offer-id', offerId, '--listing-id', listingId]);
        expect(cleanup.json.status).toBe('ready');
        const cleanupApproval = await execute('approve-cleanup', ['--state', f.state, '--offer-id', offerId, '--listing-id', listingId, '--cleanup-digest', cleanup.json.cleanupDigest]);
        expect(cleanupApproval.json.status).toBe('approved');
        const cleaned = await execute('dispatch-cleanup', ['--state', f.state, '--offer-id', offerId, '--listing-id', listingId, '--cleanup-digest', cleanup.json.cleanupDigest, '--approval-token', cleanupApproval.json.approvalToken, '--approval-digest', cleanupApproval.json.approvalDigest, '--intent-key', cleanupApproval.json.intentKey]);
        expect(cleaned.json.status).toBe('dispatched-unresolved');
        expect(state).toBe('offer');
        const cleanupWrites = calls.filter(v => /^(PUT|POST|DELETE) /.test(v) && !v.includes('/ws/api.dll')).length;
        const cleanupReplay = await execute('dispatch-cleanup', ['--state', f.state, '--offer-id', offerId, '--listing-id', listingId, '--cleanup-digest', cleanup.json.cleanupDigest, '--approval-token', cleanupApproval.json.approvalToken, '--approval-digest', cleanupApproval.json.approvalDigest, '--intent-key', cleanupApproval.json.intentKey]);
        expect(cleanupReplay.stderr[0]).toContain('CREATED_STATE_UNRESOLVED');
        expect(calls.filter(v => /^(PUT|POST|DELETE) /.test(v) && !v.includes('/ws/api.dll'))).toHaveLength(cleanupWrites);
        state = 'absent';
        const cleanupRecovered = await execute('reconcile-cleanup', ['--state', f.state, '--offer-id', offerId, '--listing-id', listingId, '--cleanup-digest', cleanup.json.cleanupDigest, '--job-id', cleaned.json.jobId, '--attempt-id', cleaned.json.attemptId, '--intent-key', cleaned.json.intentKey]);
        expect(cleanupRecovered.json.status).toBe('reconciled');
        const writesBefore = calls.filter(v => /^(PUT|POST|DELETE) /.test(v) && !v.includes('/ws/api.dll')).length;
        const replayAfterCleanup = await execute('approve-create', ['--state', f.state, '--manifest-digest', pre.json.manifestDigest]);
        expect(replayAfterCleanup.stderr[0]).toContain('INTENT_ALREADY_RECORDED');
        expect(calls.filter(v => /^(PUT|POST|DELETE) /.test(v) && !v.includes('/ws/api.dll'))).toHaveLength(writesBefore);
        expect(JSON.stringify({ created, cleaned })).not.toContain('sandbox-token-value');
        expect(JSON.stringify({ created, cleaned })).not.toContain('TESTUSER_SAFE_FIXTURE');
    });
});
