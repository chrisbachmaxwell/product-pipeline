import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { describe, expect, it } from 'vitest';
import shadowApiRoutes, { createShadowApiRouter, projectLocalListing, SHADOW_API_GET_PATHS, } from './shadow-api.js';
import { buildLiveListingCatalogSnapshot } from '../live-listing-catalog.js';
import { ListingWorkspaceReaderError, } from '../listing-workspace-reader.js';
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function registeredGetPaths() {
    const stack = shadowApiRoutes.stack;
    return stack
        .filter((layer) => layer.route?.methods.get)
        .map((layer) => layer.route.path);
}
async function requestShadowPath(pathname, method = 'GET') {
    const app = express();
    app.use(shadowApiRoutes);
    app.use('/api', (_req, res) => {
        res.status(404).json({ error: 'not available' });
    });
    const server = http.createServer(app);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    try {
        const address = server.address();
        if (!address || typeof address === 'string')
            throw new Error('Test server address unavailable');
        return await new Promise((resolve, reject) => {
            const request = http.request({ hostname: '127.0.0.1', port: address.port, path: pathname, method }, (response) => {
                response.resume();
                response.on('end', () => resolve(response.statusCode ?? 0));
            });
            request.on('error', reject);
            request.end();
        });
    }
    finally {
        await new Promise((resolve, reject) => {
            server.close((error) => {
                if (!error || error.code === 'ERR_SERVER_NOT_RUNNING')
                    resolve();
                else
                    reject(error);
            });
        });
    }
}
async function requestShadowJson(pathname, router = shadowApiRoutes) {
    const app = express();
    app.use(router);
    app.use('/api', (_req, res) => {
        res.status(404).json({ error: 'not available' });
    });
    const server = http.createServer(app);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    try {
        const address = server.address();
        if (!address || typeof address === 'string')
            throw new Error('Test server address unavailable');
        return await new Promise((resolve, reject) => {
            const request = http.get({ hostname: '127.0.0.1', port: address.port, path: pathname }, (response) => {
                let raw = '';
                response.setEncoding('utf8');
                response.on('data', (chunk) => { raw += chunk; });
                response.on('end', () => {
                    try {
                        resolve({
                            status: response.statusCode ?? 0,
                            body: JSON.parse(raw),
                        });
                    }
                    catch (error) {
                        reject(error);
                    }
                });
            });
            request.on('error', reject);
        });
    }
    finally {
        await new Promise((resolve, reject) => {
            server.close((error) => {
                if (!error || error.code === 'ERR_SERVER_NOT_RUNNING')
                    resolve();
                else
                    reject(error);
            });
        });
    }
}
describe('shadow API allowlist', () => {
    it('registers only migration, verified/projected listing, and capability reads', () => {
        expect(registeredGetPaths()).toEqual([...SHADOW_API_GET_PATHS]);
        expect(SHADOW_API_GET_PATHS).not.toEqual(expect.arrayContaining([
            '/api/status',
            '/api/orders',
            '/api/ebay/orders',
            '/api/logs',
            '/api/settings',
            '/api/test/ebay-offer/:sku',
            '/api/products/overview',
        ]));
    });
    it('serves the redacted read-only monitoring digest without provider activity', async () => {
        const router = createShadowApiRouter({
            getSnapshot: async () => { throw new Error('not called'); },
            readMonitoring: async () => ({
                schemaVersion: 1,
                status: 'attention',
                generatedAtUtc: '2026-08-26T12:00:00.000Z',
                readOnly: true,
                externalWritesPerformed: 0,
                providerReadsPerformed: 0,
                notificationsSent: 0,
                health: { migrationStore: 'verified', auditChain: 'verified',
                    catalogRead: 'pending', shadowParity: 'not-configured' },
                counters: { unresolvedJobs: 0, failedJobs: 0, reconciliationExceptions: 0,
                    shadowUnmatchedOrders: 0, shadowBlockedOrders: 0, catalogReadFailures: 0 },
                dailyDigest: {
                    dateUtc: '2026-08-25', windowStartUtc: '2026-08-25T00:00:00.000Z',
                    windowEndUtc: '2026-08-26T00:00:00.000Z', digest: `sha256:${'a'.repeat(64)}`,
                    writes: { performed: 0, succeeded: 0, failed: 0, unresolved: 0,
                        skipped: null, skippedStatus: 'not-journaled-until-g18' },
                    reconciliations: { passed: 0, blocked: 0, failed: 0 },
                    exceptions: { info: 0, warning: 0, critical: 0 },
                    shadow: { status: 'not-configured', arrivedAtUtc: null, observedCount: 0,
                        matchedCount: 0, unmatchedCount: 0, blockedCount: 0 },
                    automationObserved: false,
                },
            }),
        });
        const response = await requestShadowJson('/api/monitoring/digest', router);
        expect(response).toMatchObject({
            status: 200,
            body: { status: 'attention', readOnly: true, externalWritesPerformed: 0,
                providerReadsPerformed: 0, notificationsSent: 0 },
        });
        expect(JSON.stringify(response.body)).not.toMatch(/token|buyer|email|address|orderId|sku/i);
    });
    it('projects local listing rows without notes, credentials, or unrelated legacy fields', () => {
        const projected = projectLocalListing({
            id: 7,
            shopify_product_id: 'shopify-1',
            ebay_listing_id: 'ebay-1',
            status: 'active',
            shopify_title: 'Camera',
            shopify_sku: 'SAFE-SKU',
            shopify_price: 125,
            original_price: 130,
            updated_at: 123456,
            product_notes: 'private operator note',
            access_token: 'must-not-escape',
            buyer_username: 'must-not-escape',
            shipping_address_json: '{"name":"must-not-escape"}',
            ad_rate: 9.5,
        });
        expect(projected).toEqual({
            id: 7,
            shopify_product_id: 'shopify-1',
            ebay_listing_id: 'ebay-1',
            status: 'active',
            shopify_title: 'Camera',
            shopify_sku: 'SAFE-SKU',
            shopify_price: 125,
            original_price: 130,
            updated_at: 123456,
        });
        expect(JSON.stringify(projected)).not.toMatch(/private operator note|must-not-escape|buyer|shipping|access[_-]?token|ad_rate/i);
    });
    const liveObservedAtUtc = new Date().toISOString();
    const liveSnapshot = buildLiveListingCatalogSnapshot({
        observedAtUtc: liveObservedAtUtc,
        shopifyVariants: [{
                productId: 'gid://shopify/Product/10310708035875',
                variantId: 'gid://shopify/ProductVariant/55396000563491',
                sku: 'CAN3570-U119',
                title: 'Canon 35-70mm f/3.5-4.5 (#119) *USED*',
                variantTitle: 'Default Title',
                productStatus: 'ACTIVE',
                primaryImageUrl: null,
                imageCount: 6,
                available: 1,
                price: { amount: '39.95', currency: 'USD' },
            }],
        ebayActiveListings: [{ listingId: '147502608418', sku: 'CAN3570-U119' }],
        ebayInventoryItems: [{ sku: 'CAN3570-U119' }],
        ebayOffers: [{
                offerId: '234942877011', sku: 'CAN3570-U119', status: 'PUBLISHED',
                listingId: '147502608418', listingStatus: 'ACTIVE',
            }],
        coverage: {
            shopify: {
                source: 'shopify-admin-graphql', storeDomain: 'usedcameragear.myshopify.com',
                shopId: 'gid://shopify/Shop/86254518563', observedAtUtc: liveObservedAtUtc,
                paginationComplete: true, variantPageCount: 1, totalVariantsCaptured: 1,
                positiveStockVariants: 1, excludedZeroInventory: 0, excludedUnknownInventory: 0,
                productStatusCounts: { ACTIVE: 1 },
            },
            ebay: {
                source: 'ebay-trading-api+ebay-inventory-api', marketplaceId: 'EBAY_US',
                sellerAccountVerified: true, observedAtUtc: liveObservedAtUtc,
                trading: { paginationComplete: true, pageCount: 1, activeListingCount: 1 },
                inventory: {
                    inventoryItemsComplete: true, inventoryItemPageCount: 1, inventoryItemCount: 1,
                    offersComplete: true, offerPageCount: 1, offerCount: 1,
                    unpublishedArtifactsChecked: true,
                },
            },
        },
    });
    const liveRouter = createShadowApiRouter({ getSnapshot: async () => liveSnapshot });
    it('serves the exact live Shopify/eBay v3 catalog contract without secrets', async () => {
        const response = await requestShadowJson('/api/authoritative-listings', liveRouter);
        expect(response.status).toBe(200);
        expect(Object.keys(response.body).sort()).toEqual([
            'authoritative',
            'coverage',
            'data',
            'evidenceKind',
            'externalWritesPerformed',
            'freshness',
            'limit',
            'observedAtUtc',
            'offset',
            'remoteReadPerformed',
            'schemaVersion',
            'source',
            'summary',
            'total',
        ]);
        expect(response.body).toMatchObject({
            schemaVersion: 3,
            total: 1,
            source: 'shopify-admin-graphql+ebay-active-listings',
            evidenceKind: 'live_read',
            authoritative: true,
            remoteReadPerformed: true,
            externalWritesPerformed: 0,
            summary: {
                active: 1, notListed: 0, attention: 0, unknown: 0, totalInStock: 1, totalVisible: 1,
            },
            freshness: { state: 'fresh', maxAgeMs: 300000 },
            data: [{
                    id: 'shopify-variant:gid://shopify/ProductVariant/55396000563491',
                    shopify: {
                        productId: 'gid://shopify/Product/10310708035875',
                        variantId: 'gid://shopify/ProductVariant/55396000563491',
                        sku: 'CAN3570-U119',
                        title: 'Canon 35-70mm f/3.5-4.5 (#119) *USED*',
                        imageCount: 6,
                    },
                    ebay: {
                        sku: 'CAN3570-U119',
                        offerId: '234942877011',
                        listingId: '147502608418',
                        url: 'https://www.ebay.com/itm/147502608418',
                    },
                    lifecycleStatus: 'active',
                    lastVerifiedAtUtc: liveObservedAtUtc,
                    audit: {
                        verified: true,
                        evidenceState: 'live_verified',
                        unresolvedCount: 0,
                        recoverySupported: false,
                        currentRemoteStateVerified: true,
                    },
                }],
        });
        expect(JSON.stringify(response.body)).not.toMatch(/access.?token|refresh.?token|authorization|sellerUser|buyerUsername|customerEmail|shipping.?address|listingDescription|policyId|merchantLocation|password|cookie|credential/i);
    });
    it('projects the retained snapshot only as Unknown after a known refresh failure', async () => {
        const failedRouter = createShadowApiRouter({
            getSnapshot: async () => liveSnapshot,
            getSnapshotStatus: () => ({
                hasSuccessfulSnapshot: true,
                observedAtUtc: liveObservedAtUtc,
                lastSuccessAtEpochMs: Date.parse(liveObservedAtUtc),
                lastAttemptAtEpochMs: Date.parse(liveObservedAtUtc) + 1,
                lastFailureAtEpochMs: Date.parse(liveObservedAtUtc) + 1,
                expiresAtEpochMs: Date.parse(liveObservedAtUtc) + 60_000,
                refreshInFlight: false,
            }),
        });
        const response = await requestShadowJson('/api/authoritative-listings', failedRouter);
        expect(response).toMatchObject({
            status: 200,
            body: {
                authoritative: false,
                freshness: { state: 'refresh_failed' },
                summary: { active: 0, notListed: 0, attention: 0, unknown: 1 },
                data: [{
                        lifecycleStatus: 'unknown',
                        audit: {
                            verified: false,
                            currentRemoteStateVerified: false,
                            attentionReasons: ['source_refresh_failed'],
                        },
                    }],
            },
        });
    });
    it('filters schema-v3 live rows by active/unknown/search/exact ID and rejects invalid states', async () => {
        const active = await requestShadowJson('/api/authoritative-listings?status=active&search=147502608418&limit=1&id=shopify-variant%3Agid%3A%2F%2Fshopify%2FProductVariant%2F55396000563491', liveRouter);
        expect(active).toMatchObject({ status: 200, body: { total: 1 } });
        const notListed = await requestShadowJson('/api/authoritative-listings?status=not_listed', liveRouter);
        expect(notListed).toMatchObject({ status: 200, body: { total: 0, data: [] } });
        const missing = await requestShadowJson('/api/authoritative-listings?search=not-the-canary', liveRouter);
        expect(missing).toMatchObject({ status: 200, body: { total: 0, data: [] } });
        const unknown = await requestShadowJson('/api/authoritative-listings?status=unknown', liveRouter);
        expect(unknown).toMatchObject({ status: 200, body: { total: 0, data: [] } });
        const invalid = await requestShadowJson('/api/authoritative-listings?status=published', liveRouter);
        expect(invalid).toEqual({ status: 400, body: { error: 'Invalid listing status filter' } });
    });
    const workspaceDto = {
        schemaVersion: 1,
        evidence: {
            catalogObservedAtUtc: liveObservedAtUtc,
            detailObservedAtUtc: liveObservedAtUtc,
            freshness: 'live',
            backgroundRefreshSeconds: 60,
            remoteReadPerformed: true,
            externalWritesPerformed: 0,
        },
        catalog: liveSnapshot.rows[0],
        mapping: {
            state: 'mapped',
            joinKey: 'exact_raw_sku',
            shopifyProductId: 'gid://shopify/Product/10310708035875',
            shopifyVariantId: 'gid://shopify/ProductVariant/55396000563491',
            inventorySku: 'CAN3570-U119',
            offerId: '234942877011',
            listingId: '147502608418',
            managementModel: 'inventory_offer',
            ownership: {
                listing: 'unverified',
                mapping: 'unverified',
                price: 'marketplace_connect',
                inventory: 'marketplace_connect',
            },
            editMode: 'read_only',
        },
        ebayDetail: null,
    };
    it('serves only the exact credential-free read-only workspace GET contract', async () => {
        const requestedIds = [];
        const router = createShadowApiRouter({
            getSnapshot: async () => liveSnapshot,
            readWorkspace: async (id) => {
                requestedIds.push(id);
                return workspaceDto;
            },
        });
        const response = await requestShadowJson('/api/listing-workspace?id=shopify-variant%3Agid%3A%2F%2Fshopify%2FProductVariant%2F55396000563491', router);
        expect(response).toEqual({ status: 200, body: workspaceDto });
        expect(requestedIds).toEqual([
            'shopify-variant:gid://shopify/ProductVariant/55396000563491',
        ]);
        expect(JSON.stringify(response.body)).not.toMatch(/access.?token|refresh.?token|authorization|password|cookie|credential/i);
        await expect(requestShadowPath('/api/listing-workspace', 'POST')).resolves.toBe(404);
    });
    it('maps exact workspace misses to 404 and evidence/read failures to generic 503', async () => {
        const missing = await requestShadowJson('/api/listing-workspace?id=missing', createShadowApiRouter({
            getSnapshot: async () => liveSnapshot,
            readWorkspace: async () => { throw new ListingWorkspaceReaderError('not_found'); },
        }));
        expect(missing).toEqual({ status: 404, body: { error: 'Listing workspace was not found' } });
        const unavailable = await requestShadowJson('/api/listing-workspace?id=secret', createShadowApiRouter({
            getSnapshot: async () => liveSnapshot,
            readWorkspace: async () => { throw new Error('Bearer upstream-secret'); },
        }));
        expect(unavailable).toEqual({
            status: 503,
            body: { error: 'Verified listing workspace is unavailable' },
        });
        expect(JSON.stringify(unavailable)).not.toMatch(/upstream-secret|Bearer/i);
    });
    it('fails closed with a generic 503 when any live source is incomplete', async () => {
        const response = await requestShadowJson('/api/authoritative-listings', createShadowApiRouter({
            getSnapshot: async () => { throw new Error('Bearer secret-value source detail'); },
        }));
        expect(response).toEqual({ status: 503, body: { error: 'Verified listing evidence is unavailable' } });
        expect(JSON.stringify(response)).not.toContain('secret-value');
    });
    it('separates read capabilities from the configured local-only draft append', async () => {
        const response = await requestShadowJson('/api/capabilities', liveRouter);
        expect(response.body).toMatchObject({
            remoteReadersMounted: true,
            mutationCapabilities: [],
            localMutationCapabilities: [expect.objectContaining({
                    id: 'local-listing-draft', mounted: true,
                    availability: 'configuration-required', providerWrite: false,
                    externalWrite: false, approval: false, publishAuthorization: false,
                })],
            dataCapabilities: expect.arrayContaining([expect.objectContaining({
                    id: 'authoritative-listings', remoteRead: true, externalWrite: false,
                    evidenceKind: 'live_read',
                }), expect.objectContaining({
                    id: 'listing-workspace', remoteRead: true, externalWrite: false,
                    evidenceKind: 'live_read', editMode: 'read_only',
                })]),
        });
    });
    it.each([
        '/api/status',
        '/api/orders',
        '/api/ebay/orders',
        '/api/ebay/orders/1',
        '/api/logs',
        '/api/settings',
        '/api/test/ebay-offer/SAFE-SKU',
        '/api/products/overview',
        '/api/listings/stale',
    ])('returns 404 for unmounted legacy GET %s', async (pathname) => {
        await expect(requestShadowPath(pathname)).resolves.toBe(404);
    });
    it('mounts the narrow live reader without legacy routers or commerce writers', async () => {
        const [server, shadowRouter, liveSource] = await Promise.all([
            fs.readFile(path.join(sourceRoot, 'server/index.ts'), 'utf8'),
            fs.readFile(path.join(sourceRoot, 'server/routes/shadow-api.ts'), 'utf8'),
            fs.readFile(path.join(sourceRoot, 'server/live-listing-catalog-source.ts'), 'utf8'),
        ]);
        expect(server).toMatch(/shadowApiRoutes/);
        expect(server).not.toMatch(/apiRoutes|helpRoutes|featureRoutes|ebayOrderRoutes|ebayMetadataRoutes|migrationRoutes/);
        expect(server).not.toMatch(/getDb|getRawDb|initExtraTables|initPhotoTemplatesTable|seedDefaultSettings|seedHelpArticles/);
        expect(server).toMatch(/app\.use\('\/api', apiKeyAuth\)[\s\S]*app\.use\('\/api', writerQuarantineMiddleware\)[\s\S]*app\.post\('\/api\/listing-draft', listingDraftJsonParser\)/);
        expect(server).not.toMatch(/limit:\s*['"]50mb['"]/i);
        expect(server).toMatch(/if \(isTestMode\(\)\) \{\s*app\.get\('\/api\/test-mode'/s);
        expect(server).toMatch(/express\.static\(webDistPath, \{ index: false \}\)/);
        expect(shadowRouter).not.toMatch(/getValidEbayToken|refreshEbayUserToken|shopify\/products|ebay\/inventory/);
        expect(shadowRouter).toMatch(/openShadowDatabase/);
        expect(shadowRouter).not.toMatch(/getDb|getRawDb|db\/client/);
        expect(shadowRouter).not.toMatch(/SELECT\s+\*/i);
        expect(liveSource).not.toMatch(/getValidEbayToken|refreshEbayUserToken|db\/client|sync\//i);
        expect(liveSource).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER)\s+|\bCREATE\s+TABLE\b/i);
    });
});
