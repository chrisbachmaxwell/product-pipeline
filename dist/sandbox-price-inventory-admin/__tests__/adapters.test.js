import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { createSandboxAdapter } from '../../sandbox-listing-canary-admin/adapter.js';
import { createSandboxAlignmentAdapters } from '../adapters.js';
const dirs = [];
afterEach(() => { for (const directory of dirs.splice(0))
    rmSync(directory, { recursive: true, force: true }); });
const credentialPacket = Object.freeze({
    accessToken: 'sandbox-secret-token', sellerId: 'testuser_ppcanary-3c55629b',
    scopes: Object.freeze([
        'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
        'https://api.ebay.com/oauth/api_scope/sell.inventory',
        'https://api.ebay.com/oauth/api_scope/sell.account',
    ]),
    issuedAtUtc: '2026-08-26T11:00:00.000Z', expiresAtUtc: '2026-08-26T13:00:00.000Z',
});
describe('bounded live adapters', () => {
    it('reuses the listing canary Sandbox transport for exact reads and one bulk write', async () => {
        const directory = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sandbox-adapter-')));
        chmodSync(directory, 0o700);
        dirs.push(directory);
        const databasePath = path.join(directory, 'app.sqlite');
        const db = new Database(databasePath);
        db.exec('CREATE TABLE auth_tokens (platform TEXT, access_token TEXT)');
        db.prepare('INSERT INTO auth_tokens VALUES (?, ?)').run('shopify', 'shopify-secret');
        db.close();
        const calls = [];
        const json = (body) => new Response(JSON.stringify(body), { status: 200 });
        const fetchImpl = async (input, init) => {
            const url = String(input);
            calls.push({ url, init: init ?? {} });
            const parsed = new URL(url);
            if (parsed.host === 'usedcameragear.myshopify.com')
                return json({ data: {
                        shop: { id: 'gid://shopify/Shop/86254518563', myshopifyDomain: 'usedcameragear.myshopify.com', currencyCode: 'USD' },
                        currentAppInstallation: { app: { apiKey: '2db0555e4848a8264383dc0edfcfb8fe' }, accessScopes: [
                                { handle: 'read_products' }, { handle: 'read_inventory' }, { handle: 'read_orders' }, { handle: 'read_fulfillments' },
                            ] },
                        productVariant: { id: 'gid://shopify/ProductVariant/55519196250403', sku: 'PIPELINE-TEST-20260826',
                            price: '99.99', inventoryQuantity: 1, product: { id: 'gid://shopify/Product/10345525412131',
                                title: 'Pipeline Test', status: 'ACTIVE', tags: ['product-pipeline-test-lane'], publishedAt: null } },
                    } });
            if (parsed.host === 'apiz.sandbox.ebay.com')
                return json({ userId: 'testuser_ppcanary-3c55629b', registrationMarketplaceId: 'EBAY_US' });
            if (parsed.pathname.includes('/inventory_item/'))
                return json({ sku: 'PIPELINE-TEST-20260826',
                    availability: { shipToLocationAvailability: { quantity: 1 } }, condition: 'USED_EXCELLENT',
                    conditionDescription: 'Sandbox test', product: { title: 'PRODUCT PIPELINE SANDBOX TEST - DO NOT BUY',
                        description: 'PRODUCT PIPELINE SANDBOX TEST - DO NOT BUY', imageUrls: ['https://i.ebayimg.com/test.jpg'] } });
            if (parsed.pathname.endsWith('/offer'))
                return json({ total: 1, offers: [{ offerId: '123',
                            sku: 'PIPELINE-TEST-20260826', marketplaceId: 'EBAY_US', merchantLocationKey: 'pp-test-lane',
                            format: 'FIXED_PRICE', listingDuration: 'GTC', status: 'PUBLISHED', availableQuantity: 1,
                            pricingSummary: { price: { currency: 'USD', value: '1.00' } }, categoryId: '31388',
                            listingDescription: 'PRODUCT PIPELINE SANDBOX TEST - DO NOT BUY',
                            listingPolicies: { fulfillmentPolicyId: 'f', paymentPolicyId: 'p', returnPolicyId: 'r' },
                            listing: { listingId: '456' } }] });
            if (parsed.pathname === '/ws/api.dll')
                return new Response(`<?xml version="1.0"?><GetSellerListResponse>
        <Ack>Success</Ack><TotalNumberOfEntries>1</TotalNumberOfEntries><Item><ItemID>456</ItemID>
        <SKU>PIPELINE-TEST-20260826</SKU><Title>PRODUCT PIPELINE SANDBOX TEST - DO NOT BUY</Title>
        <Description>PRODUCT PIPELINE SANDBOX TEST - DO NOT BUY</Description><Quantity>1</Quantity>
        <CategoryID>31388</CategoryID><CurrentPrice currencyID="USD">1.00</CurrentPrice>
        <ListingStatus>Active</ListingStatus></Item></GetSellerListResponse>`, { status: 200 });
            if (parsed.pathname.endsWith('/bulk_update_price_quantity'))
                return json({ responses: [{ statusCode: 200 }] });
            throw new Error('unexpected target');
        };
        const adapters = await createSandboxAlignmentAdapters({ fetchImpl: fetchImpl, databasePath,
            credentialPacket, now: () => new Date('2026-08-26T12:00:00.000Z') });
        await adapters.readShopifySource();
        await adapters.readEbayState({ sku: 'PIPELINE-TEST-20260826', offerId: '123', listingId: '456' });
        await adapters.updatePrice({ sku: 'PIPELINE-TEST-20260826', offerId: '123' }, { currency: 'USD', value: '99.99' });
        expect(calls.map((call) => `${call.init.method}:${new URL(call.url).host}${new URL(call.url).pathname}`)).toEqual([
            'POST:usedcameragear.myshopify.com/admin/api/2026-07/graphql.json',
            'GET:apiz.sandbox.ebay.com/commerce/identity/v1/user/',
            'GET:api.sandbox.ebay.com/sell/inventory/v1/inventory_item/PIPELINE-TEST-20260826',
            'GET:api.sandbox.ebay.com/sell/inventory/v1/offer',
            'POST:api.sandbox.ebay.com/ws/api.dll',
            'POST:api.sandbox.ebay.com/sell/inventory/v1/bulk_update_price_quantity',
        ]);
        expect(calls.every((call) => !call.url.includes('https://api.ebay.com'))).toBe(true);
        expect(JSON.stringify(calls.at(-1)?.init.body)).not.toMatch(/quantity|availab/i);
    });
    it('consumes the shared bulk-write capability even when the response is rejected', async () => {
        const adapter = createSandboxAdapter({ token: credentialPacket.accessToken,
            expectedSellerId: credentialPacket.sellerId,
            fetchImpl: (async () => new Response('{}', { status: 500 })) });
        const action = { field: 'quantity', sku: 'PIPELINE-TEST-20260826', offerId: '123', quantity: 2 };
        await expect(adapter.bulkUpdatePriceQuantity(action)).rejects.toMatchObject({ code: 'WRITE_FAILED' });
        await expect(adapter.bulkUpdatePriceQuantity(action)).rejects.toMatchObject({ code: 'WRITE_CAPABILITY_CONSUMED' });
    });
});
