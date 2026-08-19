/**
 * Contract tests for the isolated listing-lifecycle operator CLI's END
 * dispatch — the Trading-model EndFixedPriceItem path over the real bounded
 * adapter with a captured network-free transport, and the Inventory-model
 * offer-withdraw path over a fake adapter. Everything runs against a real
 * on-disk migration-state store. No network access of any kind occurs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMigrationStore, deriveScopeKey, openMigrationStoreReadOnly, } from '../../migration-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../../listing-control-config.js';
import { buildListingLifecycleAdminProgram, } from '../program.js';
import { buildEndFixedPriceItemXml, createTradingEndDispatchAdapter, ListingEndDispatchError, } from '../end-dispatch-adapter.js';
const MIGRATION_SCOPE = {
    shopifyStoreDomain: LISTING_DRAFT_SCOPE.shopifyStoreDomain,
    ebayEnvironment: LISTING_DRAFT_SCOPE.ebayEnvironment,
    ebaySellerId: LISTING_DRAFT_SCOPE.ebaySellerId,
    ebayMarketplaceId: LISTING_DRAFT_SCOPE.ebayMarketplaceId,
};
const CATALOG_ID = 'shopify-variant:gid://shopify/ProductVariant/55396000800002';
const VARIANT_GID = 'gid://shopify/ProductVariant/55396000800002';
const PRODUCT_GID = 'gid://shopify/Product/10310708300002';
const SKU = 'NIK8514-U410';
const TRADING_LISTING_ID = '146052699999';
const INVENTORY_LISTING_ID = '147502611111';
const INVENTORY_OFFER_ID = '234942899000';
const NO_PRICE_OR_QUANTITY = /<\/?(?:StartPrice|Quantity)\b/iu;
const roots = [];
afterEach(() => {
    for (const root of roots.splice(0))
        fs.rmSync(root, { recursive: true, force: true });
});
function baseCatalogShopify() {
    return {
        productId: PRODUCT_GID, variantId: VARIANT_GID, sku: SKU,
        title: 'Nikon 85mm f/1.4', variantTitle: 'Default',
        productStatus: 'ACTIVE', primaryImageUrl: null, imageCount: 1, available: 1,
        price: { amount: '899.95', currency: 'USD' },
    };
}
/** One legacy Trading-managed active listing (no Inventory item, no Offer). */
function tradingWorkspace() {
    return {
        schemaVersion: 1,
        evidence: {
            catalogObservedAtUtc: '2026-08-19T18:59:00.000Z',
            detailObservedAtUtc: '2026-08-19T19:00:01.000Z',
            freshness: 'live', backgroundRefreshSeconds: 60,
            remoteReadPerformed: true, externalWritesPerformed: 0,
        },
        catalog: {
            id: CATALOG_ID,
            shopify: baseCatalogShopify(),
            ebay: {
                sku: SKU, state: 'active', listingId: TRADING_LISTING_ID, offerId: null,
                url: `https://www.ebay.com/itm/${TRADING_LISTING_ID}`,
                activeMatchCount: 1, inventoryItemCount: 0,
                offerCount: 0, unpublishedArtifactCount: 0,
            },
            lifecycleStatus: 'active',
            lastVerifiedAtUtc: '2026-08-19T18:59:00.000Z',
            audit: { verified: true, evidenceState: 'live_verified', unresolvedCount: 0,
                attentionReasons: [], recoverySupported: false, currentRemoteStateVerified: true },
        },
        mapping: {
            state: 'mapped', joinKey: 'exact_raw_sku',
            shopifyProductId: PRODUCT_GID, shopifyVariantId: VARIANT_GID,
            inventorySku: SKU, offerId: null, listingId: TRADING_LISTING_ID,
            managementModel: 'legacy_trading',
            ownership: { listing: 'unverified', mapping: 'unverified',
                price: 'marketplace_connect', inventory: 'marketplace_connect' },
            editMode: 'read_only',
        },
        ebayDetail: {
            schemaVersion: 1,
            evidence: { source: 'ebay-trading-get-item',
                observedAtUtc: '2026-08-19T19:00:01.000Z', complete: true,
                remoteReadPerformed: true, externalWritesPerformed: 0, requestCount: 2 },
            identity: { sellerId: 'usedcameragear', marketplaceId: 'EBAY_US', mappingState: 'mapped',
                shopifyProductId: PRODUCT_GID, shopifyVariantId: VARIANT_GID, sku: SKU,
                listingId: TRADING_LISTING_ID,
                publicListingUrl: `https://www.ebay.com/itm/${TRADING_LISTING_ID}`, offerId: null },
            actual: {
                lifecycle: { status: 'ACTIVE', active: true, format: 'FIXED_PRICE', duration: 'GTC',
                    startAtUtc: null, endAtUtc: null },
                content: { title: 'Nikon 85mm f/1.4 AI-S',
                    descriptionHtml: '<p>Legacy &amp; loved</p>',
                    imageUrls: ['https://i.ebayimg.com/images/g/xyz/s-l1600.jpg'] },
                category: { primary: { id: '78997', name: 'Lenses' }, secondary: null, storeCategories: [] },
                condition: { id: '3000', name: 'Used', description: 'Excellent', descriptors: [] },
                aspects: { Mount: ['Nikon F'], Brand: ['Nikon'] },
                identifiers: { brand: 'Nikon', mpn: null, upc: [], ean: [], isbn: [], epid: null },
                commerce: { price: { value: '899.95', currency: 'USD' }, totalQuantity: 1, soldQuantity: 0,
                    availableQuantity: 1, availableQuantityBasis: 'reported', bestOfferEnabled: false },
                policies: { fulfillmentPolicyId: '6055555000', paymentPolicyId: '6066666000',
                    returnPolicyId: '6077777000', paymentMethods: [], shippingType: null,
                    domesticServices: [], internationalServices: [], returnsAccepted: true,
                    returnPeriod: null, returnShippingCostPayer: null },
                location: { publicLocation: 'Utah', countryCode: 'US' },
            },
            management: { model: 'legacy_trading', controlApi: 'trading', joinKey: 'exact_raw_sku',
                exactBindings: { seller: true, listing: true, sku: true, inventoryItem: false,
                    offer: false, offerToListing: false }, lifecycleAligned: true,
                inventoryItem: null, offer: null },
        },
    };
}
/** One fully bound Inventory/Offer-managed active listing. */
function inventoryWorkspace() {
    const trading = tradingWorkspace();
    return {
        ...trading,
        catalog: {
            ...trading.catalog,
            ebay: {
                sku: SKU, state: 'active', listingId: INVENTORY_LISTING_ID, offerId: INVENTORY_OFFER_ID,
                url: `https://www.ebay.com/itm/${INVENTORY_LISTING_ID}`,
                activeMatchCount: 1, inventoryItemCount: 1,
                offerCount: 1, unpublishedArtifactCount: 0,
            },
        },
        mapping: {
            ...trading.mapping,
            inventorySku: SKU, offerId: INVENTORY_OFFER_ID, listingId: INVENTORY_LISTING_ID,
            managementModel: 'inventory_offer',
        },
        ebayDetail: {
            ...trading.ebayDetail,
            evidence: { source: 'ebay-trading-get-item+ebay-inventory-detail',
                observedAtUtc: '2026-08-19T19:00:01.000Z', complete: true,
                remoteReadPerformed: true, externalWritesPerformed: 0, requestCount: 4 },
            identity: {
                ...trading.ebayDetail.identity,
                listingId: INVENTORY_LISTING_ID,
                publicListingUrl: `https://www.ebay.com/itm/${INVENTORY_LISTING_ID}`,
                offerId: INVENTORY_OFFER_ID,
            },
            management: { model: 'inventory_offer', controlApi: 'inventory', joinKey: 'exact_raw_sku',
                exactBindings: { seller: true, listing: true, sku: true, inventoryItem: true,
                    offer: true, offerToListing: true }, lifecycleAligned: true,
                inventoryItem: { sku: SKU, content: { title: 'Nikon 85mm f/1.4 AI-S',
                        descriptionHtml: null, imageUrls: [] }, condition: { id: '3000', name: 'Used',
                        description: null, descriptors: [] }, aspects: {}, identifiers: { brand: 'Nikon',
                        mpn: null, upc: [], ean: [], isbn: [], epid: null }, shipToLocationQuantity: 1 },
                offer: { offerId: INVENTORY_OFFER_ID, sku: SKU, marketplaceId: 'EBAY_US',
                    status: 'PUBLISHED', listingStatus: 'ACTIVE', listingOnHold: false, soldQuantity: 0,
                    format: 'FIXED_PRICE', duration: 'GTC', descriptionHtml: null,
                    primaryCategoryId: '78997', secondaryCategoryId: null, storeCategoryNames: [],
                    price: null, availableQuantity: 1, quantityLimitPerBuyer: null,
                    bestOfferEnabled: false, autoAcceptPrice: null, autoDeclinePrice: null,
                    fulfillmentPolicyId: '6055555000', paymentPolicyId: '6066666000',
                    returnPolicyId: '6077777000', merchantLocationKey: 'warehouse-1',
                    includeCatalogProductDetails: false },
            },
        },
    };
}
/** The item after a verified end: Shopify only, no active eBay listing. */
function endedWorkspace() {
    return {
        schemaVersion: 1,
        evidence: {
            catalogObservedAtUtc: '2026-08-19T19:20:00.000Z',
            detailObservedAtUtc: null,
            freshness: 'live', backgroundRefreshSeconds: 60,
            remoteReadPerformed: false, externalWritesPerformed: 0,
        },
        catalog: {
            id: CATALOG_ID,
            shopify: baseCatalogShopify(),
            ebay: {
                sku: SKU, state: 'not_listed', listingId: null, offerId: null, url: null,
                activeMatchCount: 0, inventoryItemCount: 0,
                offerCount: 0, unpublishedArtifactCount: 0,
            },
            lifecycleStatus: 'not_listed',
            lastVerifiedAtUtc: '2026-08-19T19:20:00.000Z',
            audit: { verified: true, evidenceState: 'live_verified', unresolvedCount: 0,
                attentionReasons: [], recoverySupported: false, currentRemoteStateVerified: true },
        },
        mapping: {
            state: 'shopify_only', joinKey: 'exact_raw_sku',
            shopifyProductId: PRODUCT_GID, shopifyVariantId: VARIANT_GID,
            inventorySku: null, offerId: null, listingId: null,
            managementModel: 'none',
            ownership: { listing: 'unverified', mapping: 'unverified',
                price: 'marketplace_connect', inventory: 'marketplace_connect' },
            editMode: 'read_only',
        },
        ebayDetail: null,
    };
}
function createEndWorld(initial) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'listing-lifecycle-end-'));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    const migrationDatabasePath = path.join(root, 'migration-state.sqlite');
    createMigrationStore({
        databasePath: migrationDatabasePath,
        scope: MIGRATION_SCOPE,
        createdAtUtc: '2026-08-19T18:00:00.000Z',
    }).close();
    let current = initial;
    let responseAck = 'Success';
    let propagationDelay = false;
    // The real bounded Trading adapter over a captured, network-free transport.
    const tradingRequests = [];
    const fakeFetch = async (input, init) => {
        tradingRequests.push({
            url: String(input),
            headers: { ...init?.headers },
            body: String(init?.body ?? ''),
        });
        if (responseAck === 'Success' && !propagationDelay)
            current = endedWorkspace();
        return new Response('<?xml version="1.0" encoding="UTF-8"?>'
            + '<EndFixedPriceItemResponse xmlns="urn:ebay:apis:eBLBaseComponents">'
            + `<Ack>${responseAck}</Ack>`
            + '</EndFixedPriceItemResponse>', { status: 200, headers: { 'Content-Type': 'text/xml' } });
    };
    const tradingAdapter = createTradingEndDispatchAdapter({
        fetchImpl: fakeFetch,
        getAccessToken: async () => 'test-iaf-token',
    });
    const withdrawCalls = [];
    const withdrawAdapter = Object.freeze({
        withdrawOffer: async (offerId) => {
            withdrawCalls.push(offerId);
            if (!propagationDelay)
                current = endedWorkspace();
        },
    });
    const stdout = [];
    const stderr = [];
    const exitCodes = [];
    const io = {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message),
        setExitCode: (code) => exitCodes.push(code),
    };
    const run = async (argv) => {
        await buildListingLifecycleAdminProgram({
            readWorkspace: async () => current,
            draftDatabasePath: () => undefined,
            createTradingEndAdapter: () => tradingAdapter,
            createWithdrawAdapter: () => withdrawAdapter,
            io,
        }).parseAsync(argv, { from: 'user' });
    };
    return {
        migrationDatabasePath,
        setWorkspace: (dto) => { current = dto; },
        tradingRequests,
        withdrawCalls,
        setResponseAck: (ack) => { responseAck = ack; },
        setPropagationDelay: (delayed) => { propagationDelay = delayed; },
        stdout,
        stderr,
        exitCodes,
        run,
    };
}
function establishArguments(world) {
    return ['establish-ownership',
        '--migration-store', world.migrationDatabasePath,
        '--confirm-scope', deriveScopeKey(MIGRATION_SCOPE),
        '--evidence-digest', `sha256:${'a'.repeat(64)}`,
        '--responsibility', 'listingEndRelist',
    ];
}
function tradingTargetArguments() {
    return [
        '--catalog-id', CATALOG_ID,
        '--sku', SKU,
        '--listing-id', TRADING_LISTING_ID,
        '--offer-id', 'none',
        '--reason', 'not-available',
    ];
}
function inventoryTargetArguments() {
    return [
        '--catalog-id', CATALOG_ID,
        '--sku', SKU,
        '--listing-id', INVENTORY_LISTING_ID,
        '--offer-id', INVENTORY_OFFER_ID,
        '--reason', 'not-available',
    ];
}
function lastJson(lines) {
    expect(lines.length).toBeGreaterThan(0);
    return JSON.parse(lines[lines.length - 1]);
}
describe('listing-lifecycle operator CLI — end', () => {
    it('ends one Trading-model listing through one bounded EndFixedPriceItem POST', async () => {
        const world = createEndWorld(tradingWorkspace());
        await world.run(establishArguments(world));
        expect(lastJson(world.stdout)).toMatchObject({
            status: 'established', responsibility: 'listingEndRelist', version: 2,
        });
        // The only supported ending reason is not-available.
        await world.run(['preflight-end',
            '--catalog-id', CATALOG_ID, '--sku', SKU,
            '--listing-id', TRADING_LISTING_ID, '--offer-id', 'none',
            '--reason', 'sold-elsewhere',
        ]);
        expect(lastJson(world.stderr)).toMatchObject({ code: 'END_REASON_UNSUPPORTED' });
        // A numeric offer id never selects an offer-less Trading target.
        await world.run(['preflight-end',
            '--catalog-id', CATALOG_ID, '--sku', SKU,
            '--listing-id', TRADING_LISTING_ID, '--offer-id', INVENTORY_OFFER_ID,
            '--reason', 'not-available',
        ]);
        expect(lastJson(world.stderr)).toMatchObject({ code: 'END_EXACT_TARGET_MISMATCH' });
        await world.run(['preflight-end', ...tradingTargetArguments()]);
        const preview = lastJson(world.stdout);
        expect(preview).toMatchObject({
            command: 'preflight-end', status: 'preview',
            action: 'end_listing', reason: 'not-available',
        });
        expect(world.exitCodes.at(-1)).toBe(2);
        expect(world.tradingRequests).toHaveLength(0);
        const manifestDigest = preview.manifestDigest;
        expect(manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
        await world.run(['dispatch-end', ...tradingTargetArguments(),
            '--manifest-digest', manifestDigest,
            '--migration-store', world.migrationDatabasePath,
        ]);
        const dispatched = lastJson(world.stdout);
        expect(dispatched).toMatchObject({
            command: 'dispatch-end',
            status: 'dispatched-and-reconciled',
            effect: 'ended_state_observed',
            resolution: 'resolved_existing',
            providerDispatchReported: true,
            listingId: TRADING_LISTING_ID,
            externalCommerceWritesAttempted: 1,
        });
        // Exactly one bounded Trading POST with the exact call headers, carrying
        // only the ItemID and the fixed ending reason — never price or quantity.
        expect(world.withdrawCalls).toHaveLength(0);
        expect(world.tradingRequests).toHaveLength(1);
        const request = world.tradingRequests[0];
        expect(request.url).toBe('https://api.ebay.com/ws/api.dll');
        expect(request.headers['X-EBAY-API-CALL-NAME']).toBe('EndFixedPriceItem');
        expect(request.headers['X-EBAY-API-COMPATIBILITY-LEVEL']).toBe('1349');
        expect(request.headers['X-EBAY-API-SITEID']).toBe('0');
        expect(request.headers['X-EBAY-API-IAF-TOKEN']).toBe('test-iaf-token');
        expect(request.body).toContain(`<ItemID>${TRADING_LISTING_ID}</ItemID>`);
        expect(request.body).toContain('<EndingReason>NotAvailable</EndingReason>');
        expect(request.body).not.toMatch(NO_PRICE_OR_QUANTITY);
        const store = openMigrationStoreReadOnly({
            databasePath: world.migrationDatabasePath,
            expectedScope: MIGRATION_SCOPE,
        });
        expect(store.getJobStatus(dispatched.jobId)).toMatchObject({
            state: 'resolved_existing',
            responsibility: 'listingEndRelist',
        });
        expect(store.getCounts()).toMatchObject({
            idempotency_intents: 1,
            execution_jobs: 1,
            intent_attempts: 1,
            attempt_resolutions: 1,
            target_effect_observations: 1,
            listing_revise_observations: 0,
        });
        expect(store.verifyAuditChain()).toMatchObject({ valid: true });
        store.close();
        // Replaying after a verified end is denied by the fresh target gate: the
        // listing is no longer active.
        await world.run(['dispatch-end', ...tradingTargetArguments(),
            '--manifest-digest', manifestDigest,
            '--migration-store', world.migrationDatabasePath,
        ]);
        expect(lastJson(world.stderr)).toMatchObject({ code: 'END_TARGET_NOT_ACTIVE' });
        expect(world.tradingRequests).toHaveLength(1);
    });
    it('ends one Inventory-model listing through the offer withdraw path', async () => {
        const world = createEndWorld(inventoryWorkspace());
        await world.run(establishArguments(world));
        await world.run(['preflight-end', ...inventoryTargetArguments()]);
        const manifestDigest = lastJson(world.stdout).manifestDigest;
        expect(world.exitCodes.at(-1)).toBe(2);
        await world.run(['dispatch-end', ...inventoryTargetArguments(),
            '--manifest-digest', manifestDigest,
            '--migration-store', world.migrationDatabasePath,
        ]);
        const dispatched = lastJson(world.stdout);
        expect(dispatched).toMatchObject({
            command: 'dispatch-end',
            status: 'dispatched-and-reconciled',
            effect: 'ended_state_observed',
            resolution: 'resolved_existing',
            providerDispatchReported: true,
            listingId: INVENTORY_LISTING_ID,
        });
        // The withdraw path names the exact offer; the Trading transport is never touched.
        expect(world.withdrawCalls).toEqual([INVENTORY_OFFER_ID]);
        expect(world.tradingRequests).toHaveLength(0);
        const store = openMigrationStoreReadOnly({
            databasePath: world.migrationDatabasePath,
            expectedScope: MIGRATION_SCOPE,
        });
        expect(store.getJobStatus(dispatched.jobId)).toMatchObject({
            state: 'resolved_existing',
        });
        expect(store.verifyAuditChain()).toMatchObject({ valid: true });
        store.close();
    });
    it('records a provider-rejected trading end as a durable confirmed_missing outcome', async () => {
        const world = createEndWorld(tradingWorkspace());
        await world.run(establishArguments(world));
        await world.run(['preflight-end', ...tradingTargetArguments()]);
        const manifestDigest = lastJson(world.stdout).manifestDigest;
        world.setResponseAck('Failure');
        await world.run(['dispatch-end', ...tradingTargetArguments(),
            '--manifest-digest', manifestDigest,
            '--migration-store', world.migrationDatabasePath,
        ]);
        const dispatched = lastJson(world.stdout);
        expect(dispatched).toMatchObject({
            command: 'dispatch-end',
            status: 'dispatched-unresolved',
            providerDispatchReported: false,
            effect: 'ended_state_absent',
            resolution: 'confirmed_missing',
            externalCommerceWritesAttempted: 1,
        });
        expect(world.exitCodes.at(-1)).toBe(1);
        expect(world.tradingRequests).toHaveLength(1);
        const store = openMigrationStoreReadOnly({
            databasePath: world.migrationDatabasePath,
            expectedScope: MIGRATION_SCOPE,
        });
        expect(store.getJobStatus(dispatched.jobId)).toMatchObject({
            state: 'confirmed_missing',
        });
        expect(store.verifyAuditChain()).toMatchObject({ valid: true });
        store.close();
    });
    it('leaves a not-yet-visible end unresolved and resolves it through the reconcile command', async () => {
        const world = createEndWorld(tradingWorkspace());
        await world.run(establishArguments(world));
        await world.run(['preflight-end', ...tradingTargetArguments()]);
        const manifestDigest = lastJson(world.stdout).manifestDigest;
        // The provider accepted the end but the fresh capture still shows the
        // active listing (propagation delay): the job must stay unresolved —
        // absence is never auto-confirmed while the provider reported success.
        world.setPropagationDelay(true);
        await world.run(['dispatch-end', ...tradingTargetArguments(),
            '--manifest-digest', manifestDigest,
            '--migration-store', world.migrationDatabasePath,
        ]);
        const dispatched = lastJson(world.stdout);
        expect(dispatched).toMatchObject({
            command: 'dispatch-end',
            status: 'dispatched-unresolved',
            providerDispatchReported: true,
            effect: 'ended_state_absent',
            resolution: null,
            unresolvedCode: 'ENDED_STATE_NOT_YET_OBSERVED',
        });
        expect(world.exitCodes.at(-1)).toBe(1);
        const store = openMigrationStoreReadOnly({
            databasePath: world.migrationDatabasePath,
            expectedScope: MIGRATION_SCOPE,
        });
        expect(store.getJobStatus(dispatched.jobId)).toMatchObject({
            state: 'reconciliation_required',
        });
        store.close();
        // Once the ended state becomes visible, reconcile resolves the job.
        world.setWorkspace(endedWorkspace());
        await world.run(['reconcile',
            '--action', 'end',
            '--catalog-id', CATALOG_ID,
            '--sku', SKU,
            '--listing-id', TRADING_LISTING_ID,
            '--manifest-digest', manifestDigest,
            '--migration-store', world.migrationDatabasePath,
            '--job-id', dispatched.jobId,
            '--attempt-id', dispatched.attemptId,
        ]);
        expect(lastJson(world.stdout)).toMatchObject({
            command: 'reconcile',
            status: 'reconciled',
            action: 'end',
            effect: 'ended_state_observed',
            resolution: 'resolved_existing',
            externalWritesPerformed: 0,
        });
        const reopened = openMigrationStoreReadOnly({
            databasePath: world.migrationDatabasePath,
            expectedScope: MIGRATION_SCOPE,
        });
        expect(reopened.getJobStatus(dispatched.jobId)).toMatchObject({
            state: 'resolved_existing',
        });
        expect(reopened.verifyAuditChain()).toMatchObject({ valid: true });
        reopened.close();
    });
    it('serializes the one bounded end request and never a price or quantity element', () => {
        const xml = buildEndFixedPriceItemXml(TRADING_LISTING_ID);
        expect(xml).toContain(`<ItemID>${TRADING_LISTING_ID}</ItemID>`);
        expect(xml).toContain('<EndingReason>NotAvailable</EndingReason>');
        expect(xml).not.toMatch(NO_PRICE_OR_QUANTITY);
        expect(() => buildEndFixedPriceItemXml('not-an-item-id')).toThrow(ListingEndDispatchError);
    });
});
