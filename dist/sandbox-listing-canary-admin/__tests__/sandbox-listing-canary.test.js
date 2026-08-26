import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createSandboxAdapter } from '../adapter.js';
import { buildPayloads, readSandboxManifest, SANDBOX_API_ORIGIN, SANDBOX_IDENTITY_ORIGIN, } from '../manifest.js';
import { assertSandboxCreatedState, buildSandboxListingCanaryProgram, discoverSandboxRecovery, } from '../program.js';
const NOW = new Date('2026-08-26T18:00:00.000Z');
const D = `sha256:${'a'.repeat(64)}`;
const target = {
    storeDomain: 'example.myshopify.com',
    productGid: 'gid://shopify/Product/1001',
    variantGid: 'gid://shopify/ProductVariant/2002',
    sku: 'SANDBOX-CANARY-1',
    shopifyEvidenceDigest: D,
};
const roots = [];
afterEach(() => {
    for (const root of roots.splice(0))
        fs.rmSync(root, { recursive: true, force: true });
});
function manifest() {
    return {
        schemaVersion: 1,
        environment: 'sandbox',
        marketplaceId: 'EBAY_US',
        target,
        listing: {
            title: 'PRODUCT PIPELINE SANDBOX TEST - DO NOT BUY camera',
            description: 'PRODUCT PIPELINE SANDBOX TEST - DO NOT BUY',
            imageUrls: ['https://cdn.shopify.com/s/files/1/camera.jpg'],
            categoryId: '31388',
            condition: 'USED_EXCELLENT',
            conditionDescription: 'Sandbox fixture',
            quantity: 1,
            price: { currency: 'USD', value: '1.00' },
            merchantLocationKey: 'sandbox-location',
            fulfillmentPolicyId: 'sandbox-fulfillment',
            paymentPolicyId: 'sandbox-payment',
            returnPolicyId: 'sandbox-return',
        },
    };
}
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-canary-'));
    roots.push(root);
    fs.chmodSync(root, 0o700);
    const file = path.join(root, 'manifest.json');
    fs.writeFileSync(file, JSON.stringify(manifest()), { mode: 0o600 });
    return { root, file, state: path.join(root, 'sandbox-canary.sqlite') };
}
function packet() {
    return Readable.from([
        JSON.stringify({
            accessToken: 'sandbox-token-value-123456',
            sellerId: 'TESTUSER_SAFE_FIXTURE',
            scopes: [
                'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
                'https://api.ebay.com/oauth/api_scope/sell.inventory',
                'https://api.ebay.com/oauth/api_scope/sell.account',
            ],
            issuedAtUtc: '2026-08-26T17:59:00.000Z',
            expiresAtUtc: '2026-08-26T19:00:00.000Z',
        }),
    ]);
}
function createdSnapshot(offerId = 'OFFER-100', listingId = '123456789012') {
    const m = manifest();
    const payloads = buildPayloads(m);
    return {
        inventory: { sku: target.sku, ...payloads.inventory },
        offers: [{ offerId, ...payloads.offer, status: 'PUBLISHED', listingId }],
        tradingListings: [
            {
                itemId: listingId,
                sku: target.sku,
                title: m.listing.title,
                description: m.listing.description,
                quantity: 1,
                categoryId: m.listing.categoryId,
                price: '1.00',
                currency: 'USD',
                listingStatus: 'Active',
            },
        ],
    };
}
describe('sandbox canary manifest and endpoint boundary', () => {
    it('requires an exact private 0600 manifest, fixed $1 marker, and credential-free approved image URL', () => {
        const f = fixture();
        const parsed = readSandboxManifest(f.file, target);
        expect(parsed.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
        fs.chmodSync(f.file, 0o400);
        expect(() => readSandboxManifest(f.file, target)).toThrowError(/denied/);
        fs.chmodSync(f.file, 0o500);
        expect(() => readSandboxManifest(f.file, target)).toThrowError(/denied/);
        fs.chmodSync(f.file, 0o700);
        expect(() => readSandboxManifest(f.file, target)).toThrowError(/denied/);
        fs.chmodSync(f.file, 0o600);
        const bad = manifest();
        bad.listing.price.value = '9.99';
        fs.writeFileSync(f.file, JSON.stringify(bad), { mode: 0o600 });
        expect(() => readSandboxManifest(f.file, target)).toThrowError(/denied/);
        bad.listing.price.value = '1.00';
        bad.listing.imageUrls = ['https://cdn.shopify.com/camera.jpg?token=secret'];
        fs.writeFileSync(f.file, JSON.stringify(bad), { mode: 0o600 });
        expect(() => readSandboxManifest(f.file, target)).toThrowError(/denied/);
    });
    it('rejects manifest symlinks and multiply-linked files', () => {
        const f = fixture();
        const link = path.join(f.root, 'manifest-link.json');
        fs.symlinkSync(f.file, link);
        expect(() => readSandboxManifest(link, target)).toThrowError(/denied/);
        fs.unlinkSync(link);
        fs.linkSync(f.file, link);
        expect(() => readSandboxManifest(f.file, target)).toThrowError(/denied/);
    });
    it('rejects a 200 inventory echo for another SKU and unsupported offer status', async () => {
        const identity = {
            userId: 'TESTUSER_SAFE_FIXTURE',
            registrationMarketplaceId: 'EBAY_US',
        };
        const wrongItem = createSandboxAdapter({
            token: 'sandbox-token-value-123456',
            expectedSellerId: 'TESTUSER_SAFE_FIXTURE',
            now: () => NOW,
            fetchImpl: async (input) => String(input).startsWith(SANDBOX_IDENTITY_ORIGIN)
                ? new Response(JSON.stringify(identity), { status: 200 })
                : new Response(JSON.stringify({ sku: 'OTHER-SKU' }), { status: 200 }),
        });
        await wrongItem.verifyIdentity();
        await expect(wrongItem.snapshot(target.sku)).rejects.toMatchObject({
            code: 'AMBIGUOUS_REMOTE_STATE',
        });
        const invalidOffer = createSandboxAdapter({
            token: 'sandbox-token-value-123456',
            expectedSellerId: 'TESTUSER_SAFE_FIXTURE',
            now: () => NOW,
            fetchImpl: async (input) => {
                const url = String(input);
                if (url.startsWith(SANDBOX_IDENTITY_ORIGIN))
                    return new Response(JSON.stringify(identity), { status: 200 });
                if (url.includes('/inventory_item/'))
                    return new Response('', { status: 404 });
                if (url.includes('/offer?'))
                    return new Response(JSON.stringify({
                        total: 1,
                        offers: [
                            {
                                offerId: 'O1',
                                sku: target.sku,
                                marketplaceId: 'EBAY_US',
                                status: 'UNKNOWN',
                            },
                        ],
                    }), { status: 200 });
                return new Response('', { status: 500 });
            },
        });
        await invalidOffer.verifyIdentity();
        await expect(invalidOffer.snapshot(target.sku)).rejects.toMatchObject({
            code: 'AMBIGUOUS_REMOTE_STATE',
        });
    });
    it('constructs only immutable Sandbox URLs and rejects ambiguous pagination', async () => {
        const calls = [];
        const adapter = createSandboxAdapter({
            token: 'sandbox-token-value-123456',
            expectedSellerId: 'TESTUSER_SAFE_FIXTURE',
            now: () => NOW,
            fetchImpl: async (input) => {
                const url = String(input);
                calls.push(url);
                if (url.startsWith(SANDBOX_IDENTITY_ORIGIN))
                    return new Response(JSON.stringify({
                        userId: 'TESTUSER_SAFE_FIXTURE',
                        registrationMarketplaceId: 'EBAY_US',
                    }), { status: 200 });
                if (url.includes('/inventory_item/'))
                    return new Response('', { status: 404 });
                if (url.includes('/offer?'))
                    return new Response(JSON.stringify({ total: 26, offers: [] }), {
                        status: 200,
                    });
                return new Response('<GetSellerListResponse><Ack>Success</Ack><HasMoreItems>false</HasMoreItems><PaginationResult><TotalNumberOfEntries>0</TotalNumberOfEntries></PaginationResult></GetSellerListResponse>', { status: 200 });
            },
        });
        await adapter.verifyIdentity();
        await expect(adapter.snapshot(target.sku)).rejects.toMatchObject({
            code: 'AMBIGUOUS_REMOTE_STATE',
        });
        expect(calls.every((url) => url.startsWith(SANDBOX_API_ORIGIN) || url.startsWith(SANDBOX_IDENTITY_ORIGIN))).toBe(true);
        expect(calls.join(' ')).not.toContain('https://api.ebay.com/');
    });
    it('has no server runtime import or order path', () => {
        const root = path.resolve(import.meta.dirname, '../..');
        const serverFiles = fs
            .readdirSync(path.join(root, 'server'), { recursive: true })
            .filter((v) => String(v).endsWith('.ts'));
        for (const entry of serverFiles) {
            const source = fs.readFileSync(path.join(root, 'server', String(entry)), 'utf8');
            expect(source).not.toContain('sandbox-listing-canary-admin');
        }
        const slice = fs
            .readdirSync(path.resolve(import.meta.dirname, '..'))
            .filter((v) => v.endsWith('.ts'))
            .map((v) => fs.readFileSync(path.resolve(import.meta.dirname, '..', v), 'utf8'))
            .join('\n');
        expect(slice).not.toMatch(/order-import|syncOrders|createShopifyOrder|MarketplaceConnect/);
    });
    it('requires every approved create effect and exact Trading listing binding', () => {
        const base = createdSnapshot();
        expect(() => assertSandboxCreatedState(base, 'OFFER-100', '123456789012', manifest())).not.toThrow();
        const drifts = [
            {
                ...base,
                inventory: {
                    ...base.inventory,
                    conditionDescription: 'one byte drift',
                },
            },
            {
                ...base,
                inventory: {
                    ...base.inventory,
                    availability: { shipToLocationAvailability: { quantity: 2 } },
                },
            },
            {
                ...base,
                offers: [{ ...base.offers[0], listingDescription: 'one byte drift' }],
            },
            {
                ...base,
                offers: [
                    {
                        ...base.offers[0],
                        listingPolicies: {
                            ...base.offers[0].listingPolicies,
                            paymentPolicyId: 'wrong',
                        },
                    },
                ],
            },
            {
                ...base,
                offers: [
                    {
                        ...base.offers[0],
                        pricingSummary: { price: { currency: 'USD', value: '2.00' } },
                    },
                ],
            },
            { ...base, offers: [{ ...base.offers[0], listingId: '999999999999' }] },
            {
                ...base,
                tradingListings: [{ ...base.tradingListings[0], itemId: '999999999999' }],
            },
        ];
        for (const drift of drifts)
            expect(() => assertSandboxCreatedState(drift, 'OFFER-100', '123456789012', manifest())).toThrowError(/denied/);
    });
    it('classifies response-lost create residue without mutation', () => {
        const m = manifest();
        const base = createdSnapshot();
        expect(discoverSandboxRecovery({ ...base, offers: [], tradingListings: [] }, m)).toMatchObject({
            stage: 'inventory_only',
            offerId: null,
            listingId: null,
        });
        const unpublished = { ...base.offers[0], status: 'UNPUBLISHED', listingId: null };
        expect(discoverSandboxRecovery({ ...base, offers: [unpublished], tradingListings: [] }, m)).toMatchObject({ stage: 'offer_unpublished', offerId: 'OFFER-100', listingId: null });
        expect(discoverSandboxRecovery(base, m)).toMatchObject({
            stage: 'created',
            offerId: 'OFFER-100',
            listingId: '123456789012',
        });
    });
});
describe('standalone ceremony', () => {
    it('initializes separate state, contains partial outcomes, reconciles, cleans up, and denies replay', async () => {
        const f = fixture();
        let state = 'absent';
        let listingStatus = 'none';
        let failPublishOnce = true;
        let failDeleteOfferOnce = true;
        let failDeleteInventoryOnce = true;
        const calls = [];
        const offerId = 'OFFER-100';
        const listingId = '123456789012';
        const m = manifest();
        const payloads = buildPayloads(m);
        const fetchImpl = async (input, init) => {
            const url = String(input);
            const method = init?.method ?? 'GET';
            calls.push(`${method} ${url}`);
            if (url.startsWith(SANDBOX_IDENTITY_ORIGIN))
                return new Response(JSON.stringify({
                    userId: 'TESTUSER_SAFE_FIXTURE',
                    registrationMarketplaceId: 'EBAY_US',
                }), { status: 200 });
            if (url.includes('/sell/inventory/v1/location/'))
                return new Response(JSON.stringify({
                    merchantLocationKey: m.listing.merchantLocationKey,
                    merchantLocationStatus: 'ENABLED',
                }), { status: 200 });
            for (const [resource, id, field] of [
                ['fulfillment_policy', m.listing.fulfillmentPolicyId, 'fulfillmentPolicyId'],
                ['payment_policy', m.listing.paymentPolicyId, 'paymentPolicyId'],
                ['return_policy', m.listing.returnPolicyId, 'returnPolicyId'],
            ])
                if (url.includes(`/sell/account/v1/${resource}/`))
                    return new Response(JSON.stringify({ [field]: id, marketplaceId: 'EBAY_US' }), {
                        status: 200,
                    });
            if (url.endsWith('/ws/api.dll')) {
                const count = listingStatus === 'none' ? 0 : 1;
                const item = count
                    ? `<Item><ItemID>${listingId}</ItemID><SKU>${target.sku}</SKU><Title>${m.listing.title}</Title><Description>${m.listing.description}</Description><Quantity>1</Quantity><PrimaryCategory><CategoryID>${m.listing.categoryId}</CategoryID></PrimaryCategory><SellingStatus><CurrentPrice currencyID="USD">1.00</CurrentPrice><ListingStatus>${listingStatus}</ListingStatus></SellingStatus></Item>`
                    : '';
                return new Response(`<GetSellerListResponse><Ack>Success</Ack><HasMoreItems>false</HasMoreItems><PaginationResult><TotalNumberOfEntries>${count}</TotalNumberOfEntries></PaginationResult>${item}</GetSellerListResponse>`, { status: 200 });
            }
            if (url.includes('/inventory_item/')) {
                if (method === 'GET')
                    return new Response(state === 'absent' ? '' : JSON.stringify({ sku: target.sku, ...payloads.inventory }), { status: state === 'absent' ? 404 : 200 });
                if (method === 'PUT') {
                    state = 'item';
                    return new Response(null, { status: 204 });
                }
                if (method === 'DELETE') {
                    if (failDeleteInventoryOnce && listingStatus === 'Ended') {
                        failDeleteInventoryOnce = false;
                        return new Response('', { status: 500 });
                    }
                    state = 'absent';
                    return new Response(null, { status: 204 });
                }
            }
            if (url.endsWith('/offer') && method === 'POST') {
                state = 'offer';
                return new Response(JSON.stringify({ offerId }), { status: 201 });
            }
            if (url.includes('/offer?')) {
                const offers = state === 'offer' || state === 'published'
                    ? [
                        {
                            offerId,
                            ...payloads.offer,
                            status: state === 'published' ? 'PUBLISHED' : 'UNPUBLISHED',
                            ...(state === 'published' ? { listing: { listingId } } : {}),
                        },
                    ]
                    : [];
                return new Response(JSON.stringify({ total: offers.length, offers }), {
                    status: 200,
                });
            }
            if (url.endsWith(`/offer/${offerId}/publish`)) {
                if (failPublishOnce) {
                    failPublishOnce = false;
                    state = 'published';
                    listingStatus = 'Active';
                    return new Response('', { status: 500 });
                }
                state = 'published';
                listingStatus = 'Active';
                return new Response(JSON.stringify({ listingId }), { status: 200 });
            }
            if (url.endsWith(`/offer/${offerId}/withdraw`)) {
                state = 'offer';
                listingStatus = 'Ended';
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
        const base = [
            '--store-domain',
            target.storeDomain,
            '--product-gid',
            target.productGid,
            '--variant-gid',
            target.variantGid,
            '--sku',
            target.sku,
            '--shopify-evidence-digest',
            D,
            '--manifest-file',
            f.file,
        ];
        let sequence = 0;
        let currentNow = NOW;
        async function execute(command, args) {
            const stdout = [];
            const stderr = [];
            const exits = [];
            const io = {
                stdout: (m) => stdout.push(m),
                stderr: (m) => stderr.push(m),
                setExitCode: (c) => exits.push(c),
            };
            await buildSandboxListingCanaryProgram({
                io,
                stdin: packet(),
                fetchImpl,
                now: () => currentNow,
                uuid: () => `id${++sequence}`,
            }).parseAsync(['node', 'cli', command, ...base, ...args]);
            return {
                stdout,
                stderr,
                exits,
                json: stdout[0] ? JSON.parse(stdout[0]) : null,
            };
        }
        const initialized = await execute('init-store', ['--state', f.state, '--evidence-digest', D]);
        expect(initialized.stderr).toEqual([]);
        expect(initialized).toMatchObject({ json: { status: 'initialized' } });
        expect(fs.statSync(f.state).mode & 0o077).toBe(0);
        const pre = await execute('preflight', []);
        expect(pre.json.status).toBe('prerequisites-partial');
        expect(pre.exits).toEqual([2]);
        const beforeDispatch = calls.length;
        const createAction = ['--action-digest', pre.json.actionDigest];
        const writesBeforeApproval = calls.filter((v) => /^(PUT|POST|DELETE) /.test(v) && !v.includes('/ws/api.dll')).length;
        const unapproved = await execute('dispatch-create', [
            '--state',
            f.state,
            '--manifest-digest',
            pre.json.manifestDigest,
            ...createAction,
            '--approval-token',
            'sandbox-approval:not-recorded',
            '--approval-digest',
            D,
            '--intent-key',
            D,
        ]);
        expect(unapproved.stderr[0]).toContain('APPROVAL');
        expect(calls.filter((v) => /^(PUT|POST|DELETE) /.test(v) && !v.includes('/ws/api.dll'))).toHaveLength(writesBeforeApproval);
        const approved = await execute('approve-create', [
            '--state',
            f.state,
            '--manifest-digest',
            pre.json.manifestDigest,
            ...createAction,
        ]);
        expect(approved.json.status).toBe('approved');
        const activeReapproval = await execute('approve-create', [
            '--state',
            f.state,
            '--manifest-digest',
            pre.json.manifestDigest,
            ...createAction,
        ]);
        expect(activeReapproval.stderr[0]).toContain('APPROVAL_STILL_ACTIVE');
        const beforeWrong = calls.filter((v) => /^(PUT|POST|DELETE) /.test(v) && !v.includes('/ws/api.dll')).length;
        const badAction = `${pre.json.actionDigest.slice(0, -1)}${pre.json.actionDigest.endsWith('0') ? '1' : '0'}`;
        const wrongAction = await execute('dispatch-create', [
            '--state',
            f.state,
            '--manifest-digest',
            pre.json.manifestDigest,
            '--action-digest',
            badAction,
            '--approval-token',
            approved.json.approvalToken,
            '--approval-digest',
            approved.json.approvalDigest,
            '--intent-key',
            approved.json.intentKey,
        ]);
        expect(wrongAction.stderr.join('\n')).toContain('ACTION_DIGEST_MISMATCH');
        expect(calls.filter((v) => /^(PUT|POST|DELETE) /.test(v) && !v.includes('/ws/api.dll'))).toHaveLength(beforeWrong);
        const wrongIntent = await execute('dispatch-create', [
            '--state',
            f.state,
            '--manifest-digest',
            pre.json.manifestDigest,
            ...createAction,
            '--approval-token',
            approved.json.approvalToken,
            '--approval-digest',
            approved.json.approvalDigest,
            '--intent-key',
            D,
        ]);
        expect(wrongIntent.stderr[0]).toContain('MIGRATION_STORE_');
        expect(calls.filter((v) => /^(PUT|POST|DELETE) /.test(v) && !v.includes('/ws/api.dll'))).toHaveLength(beforeWrong);
        currentNow = new Date('2026-08-26T18:11:00.000Z');
        const expired = await execute('dispatch-create', [
            '--state',
            f.state,
            '--manifest-digest',
            pre.json.manifestDigest,
            ...createAction,
            '--approval-token',
            approved.json.approvalToken,
            '--approval-digest',
            approved.json.approvalDigest,
            '--intent-key',
            approved.json.intentKey,
        ]);
        expect(expired.stderr[0]).toContain('APPROVAL');
        expect(calls.filter((v) => /^(PUT|POST|DELETE) /.test(v) && !v.includes('/ws/api.dll'))).toHaveLength(beforeWrong);
        const reapproved = await execute('approve-create', [
            '--state',
            f.state,
            '--manifest-digest',
            pre.json.manifestDigest,
            ...createAction,
        ]);
        expect(reapproved.json.status).toBe('approved');
        expect(reapproved.json.intentKey).toBe(approved.json.intentKey);
        const oldAgain = await execute('dispatch-create', [
            '--state',
            f.state,
            '--manifest-digest',
            pre.json.manifestDigest,
            ...createAction,
            '--approval-token',
            approved.json.approvalToken,
            '--approval-digest',
            approved.json.approvalDigest,
            '--intent-key',
            approved.json.intentKey,
        ]);
        expect(oldAgain.stderr[0]).toContain('APPROVAL');
        const created = await execute('dispatch-create', [
            '--state',
            f.state,
            '--manifest-digest',
            pre.json.manifestDigest,
            ...createAction,
            '--approval-token',
            reapproved.json.approvalToken,
            '--approval-digest',
            reapproved.json.approvalDigest,
            '--intent-key',
            reapproved.json.intentKey,
        ]);
        expect(created.json.status).toBe('dispatched-unresolved');
        expect(created.json.offerId).toBe(offerId);
        expect(created.json.listingId).toBeNull();
        expect(state).toBe('published');
        const writesAfterUnknown = calls.filter((v) => /^(PUT|POST|DELETE) /.test(v) && !v.includes('/ws/api.dll')).length;
        const replay = await execute('dispatch-create', [
            '--state',
            f.state,
            '--manifest-digest',
            pre.json.manifestDigest,
            ...createAction,
            '--approval-token',
            reapproved.json.approvalToken,
            '--approval-digest',
            reapproved.json.approvalDigest,
            '--intent-key',
            reapproved.json.intentKey,
        ]);
        expect(replay.stderr[0]).toContain('TARGET_NOT_ABSENT');
        expect(calls.filter((v) => /^(PUT|POST|DELETE) /.test(v) && !v.includes('/ws/api.dll'))).toHaveLength(writesAfterUnknown);
        const recovered = await execute('recover-create', [
            '--state',
            f.state,
            '--manifest-digest',
            pre.json.manifestDigest,
            ...createAction,
            '--job-id',
            created.json.jobId,
            '--attempt-id',
            created.json.attemptId,
            '--intent-key',
            created.json.intentKey,
        ]);
        expect(recovered.json.status).toBe('reconciled');
        expect(recovered.json).toMatchObject({ offerId, listingId, stage: 'created' });
        const auditBeforeReplay = (await execute('verify-state', ['--state', f.state])).json.audit
            .recordCount;
        const terminalReplay = await execute('recover-create', [
            '--state',
            f.state,
            '--manifest-digest',
            pre.json.manifestDigest,
            ...createAction,
            '--job-id',
            created.json.jobId,
            '--attempt-id',
            created.json.attemptId,
            '--intent-key',
            created.json.intentKey,
        ]);
        expect(terminalReplay.stderr[0]).toContain('RECONCILIATION_BINDING_INVALID');
        expect((await execute('verify-state', ['--state', f.state])).json.audit.recordCount).toBe(auditBeforeReplay);
        const dispatchCalls = calls.slice(beforeDispatch);
        expect(dispatchCalls.findIndex((v) => v.startsWith('GET '))).toBeLessThan(dispatchCalls.findIndex((v) => v.startsWith('PUT ')));
        const cleanup = await execute('preflight-cleanup', [
            '--offer-id',
            offerId,
            '--listing-id',
            listingId,
        ]);
        expect(cleanup.json.status).toBe('ready');
        const cleanupApproval = await execute('approve-cleanup', [
            '--state',
            f.state,
            '--offer-id',
            offerId,
            '--listing-id',
            listingId,
            '--cleanup-digest',
            cleanup.json.cleanupDigest,
        ]);
        expect(cleanupApproval.json.status).toBe('approved');
        const cleaned = await execute('dispatch-cleanup', [
            '--state',
            f.state,
            '--offer-id',
            offerId,
            '--listing-id',
            listingId,
            '--cleanup-digest',
            cleanup.json.cleanupDigest,
            '--approval-token',
            cleanupApproval.json.approvalToken,
            '--approval-digest',
            cleanupApproval.json.approvalDigest,
            '--intent-key',
            cleanupApproval.json.intentKey,
        ]);
        expect(cleaned.json.status).toBe('dispatched-unresolved');
        expect(state).toBe('offer');
        const cleanupWrites = calls.filter((v) => /^(PUT|POST|DELETE) /.test(v) && !v.includes('/ws/api.dll')).length;
        const cleanupReplay = await execute('dispatch-cleanup', [
            '--state',
            f.state,
            '--offer-id',
            offerId,
            '--listing-id',
            listingId,
            '--cleanup-digest',
            cleanup.json.cleanupDigest,
            '--approval-token',
            cleanupApproval.json.approvalToken,
            '--approval-digest',
            cleanupApproval.json.approvalDigest,
            '--intent-key',
            cleanupApproval.json.intentKey,
        ]);
        expect(cleanupReplay.stderr[0]).toContain('CREATED_STATE_UNRESOLVED');
        expect(calls.filter((v) => /^(PUT|POST|DELETE) /.test(v) && !v.includes('/ws/api.dll'))).toHaveLength(cleanupWrites);
        const recoverySource = [
            '--source-responsibility',
            'listingEndRelist',
            '--source-job-id',
            cleaned.json.jobId,
            '--source-attempt-id',
            cleaned.json.attemptId,
            '--source-intent-key',
            cleaned.json.intentKey,
            '--source-evidence-digest',
            cleanup.json.cleanupDigest,
        ];
        const recoveryCleanup = await execute('preflight-recovery-cleanup', [
            '--state',
            f.state,
            ...recoverySource,
        ]);
        expect(recoveryCleanup.json).toMatchObject({
            status: 'ready',
            stage: 'offer_unpublished_ended',
            offerId,
            listingId,
        });
        const recoveryApproval = await execute('approve-recovery-cleanup', [
            '--state',
            f.state,
            ...recoverySource,
            '--recovery-digest',
            recoveryCleanup.json.recoveryDigest,
        ]);
        expect(recoveryApproval.json.status).toBe('approved');
        const cleanupRecovered = await execute('dispatch-recovery-cleanup', [
            '--state',
            f.state,
            ...recoverySource,
            '--recovery-digest',
            recoveryCleanup.json.recoveryDigest,
            '--approval-token',
            recoveryApproval.json.approvalToken,
            '--approval-digest',
            recoveryApproval.json.approvalDigest,
            '--intent-key',
            recoveryApproval.json.intentKey,
        ]);
        expect(cleanupRecovered.json.status).toBe('dispatched-unresolved');
        expect(state).toBe('item');
        const wrongEvidenceAudit = (await execute('verify-state', ['--state', f.state])).json.audit.recordCount;
        const wrongEvidence = await execute('reconcile-recovery-cleanup', ['--state', f.state, '--recovery-digest', D, '--listing-id', listingId, '--job-id', cleanupRecovered.json.jobId, '--attempt-id', cleanupRecovered.json.attemptId, '--intent-key', cleanupRecovered.json.intentKey]);
        expect(wrongEvidence.stderr[0]).toContain('RECONCILIATION_BINDING_INVALID');
        expect((await execute('verify-state', ['--state', f.state])).json.audit.recordCount).toBe(wrongEvidenceAudit);
        const secondSource = [
            '--source-responsibility',
            'listingEndRelist',
            '--source-job-id',
            cleanupRecovered.json.jobId,
            '--source-attempt-id',
            cleanupRecovered.json.attemptId,
            '--source-intent-key',
            cleanupRecovered.json.intentKey,
            '--source-evidence-digest',
            recoveryCleanup.json.recoveryDigest,
        ];
        const secondPreflight = await execute('preflight-recovery-cleanup', [
            '--state',
            f.state,
            ...secondSource,
        ]);
        expect(secondPreflight.json).toMatchObject({
            status: 'ready',
            stage: 'inventory_only_ended',
            offerId: null,
            listingId,
        });
        const secondApproval = await execute('approve-recovery-cleanup', [
            '--state',
            f.state,
            ...secondSource,
            '--recovery-digest',
            secondPreflight.json.recoveryDigest,
        ]);
        const finalCleanup = await execute('dispatch-recovery-cleanup', [
            '--state',
            f.state,
            ...secondSource,
            '--recovery-digest',
            secondPreflight.json.recoveryDigest,
            '--approval-token',
            secondApproval.json.approvalToken,
            '--approval-digest',
            secondApproval.json.approvalDigest,
            '--intent-key',
            secondApproval.json.intentKey,
        ]);
        expect(finalCleanup.json.status).toBe('cleaned-and-reconciled');
        expect(state).toBe('absent');
        const recoveryAudit = (await execute('verify-state', ['--state', f.state])).json.audit
            .recordCount;
        const recoveryReplay = await execute('reconcile-recovery-cleanup', [
            '--state',
            f.state,
            '--recovery-digest',
            secondPreflight.json.recoveryDigest,
            '--listing-id',
            listingId,
            '--job-id',
            finalCleanup.json.jobId,
            '--attempt-id',
            finalCleanup.json.attemptId,
            '--intent-key',
            finalCleanup.json.intentKey,
        ]);
        expect(recoveryReplay.stderr[0]).toContain('RECONCILIATION_BINDING_INVALID');
        expect((await execute('verify-state', ['--state', f.state])).json.audit.recordCount).toBe(recoveryAudit);
        const writesBefore = calls.filter((v) => /^(PUT|POST|DELETE) /.test(v) && !v.includes('/ws/api.dll')).length;
        const replayAfterCleanup = await execute('approve-create', [
            '--state',
            f.state,
            '--manifest-digest',
            pre.json.manifestDigest,
            ...createAction,
        ]);
        expect(replayAfterCleanup.stderr[0]).toContain('TARGET_NOT_ABSENT');
        expect(calls.filter((v) => /^(PUT|POST|DELETE) /.test(v) && !v.includes('/ws/api.dll'))).toHaveLength(writesBefore);
        expect(JSON.stringify({ created, cleaned })).not.toContain('sandbox-token-value');
        expect(JSON.stringify({ created, cleaned })).not.toContain('TESTUSER_SAFE_FIXTURE');
    });
});
