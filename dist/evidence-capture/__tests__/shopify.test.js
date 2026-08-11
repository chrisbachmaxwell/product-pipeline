import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { SHOPIFY_ADMIN_API_VERSION, SHOPIFY_GRAPHQL_DOCUMENTS, captureShopifyAuthoritativeEvidence, } from '../shopify.js';
const NOW = '2026-08-11T20:00:00.000Z';
const TOKEN = 'shpat_fixture_secret_never_log';
function config(overrides = {}) {
    return {
        storeDomain: 'usedcameragear.myshopify.com',
        expectedShopId: 'gid://shopify/Shop/100',
        expectedAppId: 'gid://shopify/App/200',
        authorityExpiresAtUtc: '2026-08-11T21:00:00.000Z',
        orderWindow: {
            startUtc: '2026-08-10T20:00:00.000Z',
            endUtc: NOW,
        },
        limits: {
            variantPageSize: 2,
            orderPageSize: 2,
            maxVariantPages: 4,
            maxOrderPages: 4,
            maxRequests: 9,
            maxResponseBytes: 128 * 1024,
        },
        ...overrides,
    };
}
function response(data) {
    return {
        status: 200,
        apiVersion: SHOPIFY_ADMIN_API_VERSION,
        body: {
            data,
            extensions: {
                cost: {
                    throttleStatus: {
                        currentlyAvailable: 90,
                        maximumAvailable: 100,
                        restoreRate: 100,
                    },
                },
            },
        },
    };
}
function preflight(overrides = {}) {
    return response({
        shop: {
            id: 'gid://shopify/Shop/100',
            myshopifyDomain: 'usedcameragear.myshopify.com',
            currencyCode: 'USD',
        },
        currentAppInstallation: {
            id: 'gid://shopify/AppInstallation/300',
            app: { id: 'gid://shopify/App/200' },
            accessScopes: [
                { handle: 'read_products' },
                { handle: 'read_orders' },
                { handle: 'read_inventory' },
                { handle: 'read_fulfillments' },
            ],
        },
        ...overrides,
    });
}
function variant(id, extra = {}) {
    return {
        id: `gid://shopify/ProductVariant/${id}`,
        sku: `SAFE-SKU-${id}`,
        price: '129.95',
        inventoryQuantity: 1,
        updatedAt: '2026-08-11T19:30:00.000Z',
        product: {
            id: `gid://shopify/Product/${Math.ceil(id / 2)}`,
            status: 'ACTIVE',
            updatedAt: '2026-08-11T19:25:00.000Z',
        },
        inventoryItem: {
            id: `gid://shopify/InventoryItem/${id}`,
            tracked: true,
            inventoryLevels: {
                nodes: [{
                        id: `gid://shopify/InventoryLevel/${id}?inventory_item_id=${id}`,
                        isActive: true,
                        updatedAt: '2026-08-11T19:20:00.000Z',
                        location: { id: 'gid://shopify/Location/400' },
                        quantities: [{ name: 'available', quantity: 1 }],
                    }],
                pageInfo: { hasNextPage: false, endCursor: null },
            },
        },
        ...extra,
    };
}
function order(id, extra = {}) {
    return {
        id: `gid://shopify/Order/${id}`,
        createdAt: '2026-08-11T18:00:00.000Z',
        updatedAt: '2026-08-11T18:05:00.000Z',
        app: { id: 'gid://shopify/App/900', name: 'Marketplace Connect' },
        sourceName: 'marketplace-connect',
        sourceIdentifier: `EBAY-${id}`,
        displayFinancialStatus: 'PAID',
        displayFulfillmentStatus: 'UNFULFILLED',
        test: false,
        ...extra,
    };
}
function terminalVariants(nodes = [variant(1)]) {
    return response({
        productVariants: {
            nodes,
            pageInfo: { hasNextPage: false, endCursor: null },
        },
    });
}
function terminalOrders(nodes = [order(1)]) {
    return response({
        orders: {
            nodes,
            pageInfo: { hasNextPage: false, endCursor: null },
        },
    });
}
function fixedNow() {
    return new Date(NOW);
}
function queueDispatcher(items, requests = []) {
    return async (request) => {
        requests.push(request);
        const next = items.shift();
        if (!next)
            throw new Error('unexpected request');
        return next;
    };
}
describe('Shopify authoritative evidence collector', () => {
    it('uses only pinned static query documents and returns complete PII-minimal evidence', async () => {
        const requests = [];
        const dispatcher = queueDispatcher([
            preflight(),
            response({
                productVariants: {
                    nodes: [variant(1, { title: 'must not escape' })],
                    pageInfo: { hasNextPage: true, endCursor: 'variants-page-2' },
                },
            }),
            terminalVariants([variant(2)]),
            response({
                orders: {
                    nodes: [order(1, {
                            customer: { email: 'buyer@example.test' },
                            shippingAddress: { phone: '555-0100' },
                        })],
                    pageInfo: { hasNextPage: true, endCursor: 'orders-page-2' },
                },
            }),
            terminalOrders([order(2)]),
        ], requests);
        const result = await captureShopifyAuthoritativeEvidence(config(), {
            dispatcher,
            now: fixedNow,
        });
        expect(requests).toHaveLength(5);
        for (const request of requests) {
            expect(request).toMatchObject({
                method: 'POST',
                url: 'https://usedcameragear.myshopify.com/admin/api/2026-07/graphql.json',
                redirect: 'error',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                },
                authority: {
                    kind: 'injected-shopify-read-authority',
                    secretExposed: false,
                },
            });
            expect(request.body.query.trimStart()).toMatch(/^query\s/);
            expect(request.body.query).not.toMatch(/\bmutation\b|\bsubscription\b/);
        }
        expect(requests.map((entry) => entry.body.query)).toEqual([
            SHOPIFY_GRAPHQL_DOCUMENTS.preflight,
            SHOPIFY_GRAPHQL_DOCUMENTS.variants,
            SHOPIFY_GRAPHQL_DOCUMENTS.variants,
            SHOPIFY_GRAPHQL_DOCUMENTS.orders,
            SHOPIFY_GRAPHQL_DOCUMENTS.orders,
        ]);
        expect(requests[1].body.variables).toEqual({ first: 2, after: null });
        expect(requests[2].body.variables).toEqual({ first: 2, after: 'variants-page-2' });
        expect(requests[3].body.variables).toEqual({
            first: 2,
            after: null,
            query: "created_at:>='2026-08-10T20:00:00.000Z' created_at:<'2026-08-11T20:00:00.000Z'",
        });
        expect(requests[4].body.variables).toEqual({
            first: 2,
            after: 'orders-page-2',
            query: "created_at:>='2026-08-10T20:00:00.000Z' created_at:<'2026-08-11T20:00:00.000Z'",
        });
        expect(result.identity).toEqual({
            shopId: 'gid://shopify/Shop/100',
            storeDomain: 'usedcameragear.myshopify.com',
            appId: 'gid://shopify/App/200',
        });
        expect(result.variants).toHaveLength(2);
        expect(result.variants[0]).toEqual({
            productId: 'gid://shopify/Product/1',
            productStatus: 'ACTIVE',
            productUpdatedAtUtc: '2026-08-11T19:25:00.000Z',
            variantId: 'gid://shopify/ProductVariant/1',
            sku: 'SAFE-SKU-1',
            price: { amount: '129.95', currencyCode: 'USD' },
            aggregateAvailable: 1,
            variantUpdatedAtUtc: '2026-08-11T19:30:00.000Z',
            inventoryItemId: 'gid://shopify/InventoryItem/1',
            inventoryTracked: true,
            inventoryByLocation: [{
                    inventoryLevelId: 'gid://shopify/InventoryLevel/1?inventory_item_id=1',
                    locationId: 'gid://shopify/Location/400',
                    active: true,
                    available: 1,
                    updatedAtUtc: '2026-08-11T19:20:00.000Z',
                }],
        });
        expect(result.orders[0]).toEqual({
            orderId: 'gid://shopify/Order/1',
            createdAtUtc: '2026-08-11T18:00:00.000Z',
            updatedAtUtc: '2026-08-11T18:05:00.000Z',
            app: { id: 'gid://shopify/App/900', name: 'Marketplace Connect' },
            sourceName: 'marketplace-connect',
            sourceIdentifier: 'EBAY-1',
            financialStatus: 'PAID',
            fulfillmentStatus: 'UNFULFILLED',
            test: false,
        });
        expect(result.provenance).toMatchObject({
            apiVersion: '2026-07',
            observedAtUtc: NOW,
            variantPageCount: 2,
            orderPageCount: 2,
            requestCount: 5,
            paginationComplete: true,
            readOnly: true,
            externalWritesPerformed: false,
            historicalBackfillPerformed: false,
        });
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain(TOKEN);
        expect(serialized).not.toContain('buyer@example.test');
        expect(serialized).not.toContain('555-0100');
        expect(serialized).not.toContain('must not escape');
        expect(serialized).not.toContain('variants-page-2');
        expect(serialized).not.toContain('orders-page-2');
    });
    it('fails before dispatch for invalid authority, expired credentials, and non-recent windows', async () => {
        const dispatcher = vi.fn();
        const invalid = [
            config({ storeDomain: 'usedcameragear.myshopify.com.attacker.test' }),
            config({ expectedShopId: '100' }),
            config({ expectedAppId: '200' }),
            config({
                orderWindow: {
                    startUtc: '2026-08-04T19:59:59.999Z',
                    endUtc: NOW,
                },
            }),
            config({
                orderWindow: {
                    startUtc: '2026-08-10T19:00:00.000Z',
                    endUtc: '2026-08-11T19:30:00.000Z',
                },
            }),
        ];
        for (const input of invalid) {
            await expect(captureShopifyAuthoritativeEvidence(input, {
                dispatcher,
                now: fixedNow,
            })).rejects.toMatchObject({ code: 'configuration-denied' });
        }
        await expect(captureShopifyAuthoritativeEvidence(config({
            authorityExpiresAtUtc: NOW,
        }), { dispatcher, now: fixedNow })).rejects.toMatchObject({ code: 'credential-expired' });
        expect(dispatcher).not.toHaveBeenCalled();
    });
    it('requires exact shop, domain, app, and least-privilege granted scopes', async () => {
        const cases = [
            {
                response: preflight({
                    shop: {
                        id: 'gid://shopify/Shop/999',
                        myshopifyDomain: 'usedcameragear.myshopify.com',
                        currencyCode: 'USD',
                    },
                }),
                code: 'identity-mismatch',
            },
            {
                response: preflight({
                    currentAppInstallation: {
                        id: 'gid://shopify/AppInstallation/300',
                        app: { id: 'gid://shopify/App/999' },
                        accessScopes: [
                            { handle: 'read_products' },
                            { handle: 'read_orders' },
                            { handle: 'read_inventory' },
                        ],
                    },
                }),
                code: 'identity-mismatch',
            },
            {
                response: preflight({
                    currentAppInstallation: {
                        id: 'gid://shopify/AppInstallation/300',
                        app: { id: 'gid://shopify/App/200' },
                        accessScopes: [{ handle: 'read_products' }, { handle: 'read_inventory' }],
                    },
                }),
                code: 'scope-denied',
            },
            {
                response: preflight({
                    currentAppInstallation: {
                        id: 'gid://shopify/AppInstallation/300',
                        app: { id: 'gid://shopify/App/200' },
                        accessScopes: [
                            { handle: 'read_products' },
                            { handle: 'read_orders' },
                            { handle: 'read_inventory' },
                            { handle: 'read_all_orders' },
                        ],
                    },
                }),
                code: 'scope-denied',
            },
            {
                response: preflight({
                    currentAppInstallation: {
                        id: 'gid://shopify/AppInstallation/300',
                        app: { id: 'gid://shopify/App/200' },
                        accessScopes: [
                            { handle: 'read_products' },
                            { handle: 'read_orders' },
                            { handle: 'read_inventory' },
                            { handle: 'write_products' },
                        ],
                    },
                }),
                code: 'scope-denied',
            },
        ];
        for (const testCase of cases) {
            const dispatcher = vi.fn(async () => testCase.response);
            await expect(captureShopifyAuthoritativeEvidence(config(), {
                dispatcher,
                now: fixedNow,
            })).rejects.toMatchObject({ code: testCase.code });
            expect(dispatcher).toHaveBeenCalledTimes(1);
        }
    });
    it('fails closed on HTTP, API-version, GraphQL, throttle, malformed, and dispatcher errors', async () => {
        const cases = [
            { result: { status: 401, apiVersion: '2026-07', body: {} }, code: 'transport-unavailable' },
            { result: { status: 200, apiVersion: '2026-04', body: { data: {} } }, code: 'api-version-mismatch' },
            {
                result: {
                    status: 200,
                    apiVersion: '2026-07',
                    body: { data: {}, errors: [{ message: 'raw secret detail' }] },
                },
                code: 'graphql-error',
            },
            {
                result: {
                    status: 200,
                    apiVersion: '2026-07',
                    body: { errors: [{ extensions: { code: 'THROTTLED' } }] },
                },
                code: 'throttled',
            },
            { result: { status: 429, apiVersion: '2026-07', body: {} }, code: 'throttled' },
            { result: { status: 200, apiVersion: '2026-07', body: { data: null } }, code: 'response-invalid' },
            { result: new Error('raw dispatcher secret'), code: 'transport-unavailable' },
        ];
        for (const testCase of cases) {
            const dispatcher = async () => {
                if (testCase.result instanceof Error)
                    throw testCase.result;
                return testCase.result;
            };
            const promise = captureShopifyAuthoritativeEvidence(config(), { dispatcher, now: fixedNow });
            await expect(promise).rejects.toMatchObject({ code: testCase.code });
            await expect(promise).rejects.not.toHaveProperty('message', expect.stringContaining('secret'));
        }
    });
    it('rejects incomplete nested inventory, cursor loops, duplicate IDs, and out-of-window orders', async () => {
        const nestedPartial = variant(1);
        const inventoryItem = nestedPartial.inventoryItem;
        inventoryItem.inventoryLevels = {
            nodes: [],
            pageInfo: { hasNextPage: true, endCursor: 'more-locations' },
        };
        await expect(captureShopifyAuthoritativeEvidence(config(), {
            dispatcher: queueDispatcher([preflight(), terminalVariants([nestedPartial])]),
            now: fixedNow,
        })).rejects.toMatchObject({ code: 'pagination-incomplete' });
        await expect(captureShopifyAuthoritativeEvidence(config(), {
            dispatcher: queueDispatcher([
                preflight(),
                response({
                    productVariants: {
                        nodes: [variant(1)],
                        pageInfo: { hasNextPage: true, endCursor: 'same-cursor' },
                    },
                }),
                response({
                    productVariants: {
                        nodes: [variant(2)],
                        pageInfo: { hasNextPage: true, endCursor: 'same-cursor' },
                    },
                }),
            ]),
            now: fixedNow,
        })).rejects.toMatchObject({ code: 'pagination-loop' });
        await expect(captureShopifyAuthoritativeEvidence(config(), {
            dispatcher: queueDispatcher([
                preflight(),
                terminalVariants([variant(1), variant(1)]),
            ]),
            now: fixedNow,
        })).rejects.toMatchObject({ code: 'duplicate-resource' });
        await expect(captureShopifyAuthoritativeEvidence(config(), {
            dispatcher: queueDispatcher([
                preflight(),
                terminalVariants(),
                terminalOrders([order(1, { createdAt: '2026-08-01T18:00:00.000Z' })]),
            ]),
            now: fixedNow,
        })).rejects.toMatchObject({ code: 'response-invalid' });
        await expect(captureShopifyAuthoritativeEvidence(config(), {
            dispatcher: queueDispatcher([
                preflight(),
                terminalVariants(),
                terminalOrders([order(1, { createdAt: NOW })]),
            ]),
            now: fixedNow,
        })).rejects.toMatchObject({ code: 'response-invalid' });
    });
    it('rejects PII-shaped source identifiers rather than serializing them', async () => {
        await expect(captureShopifyAuthoritativeEvidence(config(), {
            dispatcher: queueDispatcher([
                preflight(),
                terminalVariants(),
                terminalOrders([order(1, { sourceIdentifier: 'buyer@example.test' })]),
            ]),
            now: fixedNow,
        })).rejects.toMatchObject({ code: 'response-invalid' });
    });
    it('has no ambient network, environment, legacy client, persistence, or mutation path', async () => {
        const sourcePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'shopify.ts');
        const source = await fs.readFile(sourcePath, 'utf8');
        expect(source).not.toMatch(/\bfetch\s*\(|process\.env|loadShopifyCredentials|createShopifyGraphqlClient/);
        expect(source).not.toMatch(/from\s+['"][^'"]*(?:shopify|database|migration-store|token-manager)/);
        expect(source).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/);
        expect(source).not.toMatch(/\bmutation\b/);
        expect(Object.values(SHOPIFY_GRAPHQL_DOCUMENTS)).toHaveLength(3);
    });
});
