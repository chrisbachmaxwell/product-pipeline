import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { describe, expect, it } from 'vitest';
import shadowApiRoutes, { projectLocalListing, SHADOW_API_GET_PATHS, } from './shadow-api.js';
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function registeredGetPaths() {
    const stack = shadowApiRoutes.stack;
    return stack
        .filter((layer) => layer.route?.methods.get)
        .map((layer) => layer.route.path);
}
async function requestShadowPath(pathname) {
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
            const request = http.get({ hostname: '127.0.0.1', port: address.port, path: pathname }, (response) => {
                response.resume();
                response.on('end', () => resolve(response.statusCode ?? 0));
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
async function requestShadowJson(pathname) {
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
    it('serves only the timestamped verified Canon snapshot from the authoritative-listings read', async () => {
        const response = await requestShadowJson('/api/authoritative-listings');
        expect(response.status).toBe(200);
        expect(Object.keys(response.body).sort()).toEqual([
            'authoritative',
            'data',
            'evidenceKind',
            'externalWritesPerformed',
            'limit',
            'offset',
            'remoteReadPerformed',
            'schemaVersion',
            'source',
            'total',
        ]);
        expect(response.body).toMatchObject({
            schemaVersion: 1,
            total: 1,
            source: 'production-listing-audit-ledger',
            evidenceKind: 'verified_snapshot',
            authoritative: false,
            remoteReadPerformed: false,
            externalWritesPerformed: 0,
            data: [{
                    id: 'production:EBAY_US:CAN3570-U119',
                    shopify: {
                        productId: 'gid://shopify/Product/10310708035875',
                        variantId: 'gid://shopify/ProductVariant/55396000563491',
                        sku: 'CAN3570-U119',
                        title: 'Canon 35-70mm f/3.5-4.5 (#119) *USED*',
                        imageCount: 6,
                    },
                    ebay: {
                        offerId: '234942877011',
                        listingId: '147502608418',
                        url: 'https://www.ebay.com/itm/147502608418',
                    },
                    lifecycleStatus: 'active',
                    lastVerifiedAtUtc: '2026-08-13T16:43:19.281Z',
                    audit: {
                        verified: true,
                        evidenceState: 'verified',
                        unresolvedCount: 0,
                        recoverySupported: true,
                        currentRemoteStateVerified: false,
                    },
                }],
        });
        expect(JSON.stringify(response.body)).not.toMatch(/access.?token|refresh.?token|authorization|sellerUser|buyerUsername|customerEmail|shipping.?address|listingDescription|policyId|merchantLocation|password|cookie|credential/i);
    });
    it('filters the verified snapshot and rejects unknown lifecycle states', async () => {
        const active = await requestShadowJson('/api/authoritative-listings?status=active&search=147502608418&limit=1');
        expect(active).toMatchObject({ status: 200, body: { total: 1 } });
        const ready = await requestShadowJson('/api/authoritative-listings?status=ready');
        expect(ready).toMatchObject({ status: 200, body: { total: 0, data: [] } });
        const missing = await requestShadowJson('/api/authoritative-listings?search=not-the-canary');
        expect(missing).toMatchObject({ status: 200, body: { total: 0, data: [] } });
        const invalid = await requestShadowJson('/api/authoritative-listings?status=published');
        expect(invalid).toEqual({ status: 400, body: { error: 'Invalid listing status filter' } });
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
    it('does not mount legacy routers or a remote/token reader in the running server', async () => {
        const [server, shadowRouter, authoritativeReader] = await Promise.all([
            fs.readFile(path.join(sourceRoot, 'server/index.ts'), 'utf8'),
            fs.readFile(path.join(sourceRoot, 'server/routes/shadow-api.ts'), 'utf8'),
            fs.readFile(path.join(sourceRoot, 'server/authoritative-listings-reader.ts'), 'utf8'),
        ]);
        expect(server).toMatch(/shadowApiRoutes/);
        expect(server).not.toMatch(/apiRoutes|helpRoutes|featureRoutes|ebayOrderRoutes|ebayMetadataRoutes|migrationRoutes/);
        expect(server).not.toMatch(/getDb|getRawDb|initExtraTables|initPhotoTemplatesTable|seedDefaultSettings|seedHelpArticles/);
        expect(server).toMatch(/express\.json\(\{ limit: '64kb' \}\)/);
        expect(server).not.toMatch(/limit:\s*['"]50mb['"]/i);
        expect(server).toMatch(/if \(isTestMode\(\)\) \{\s*app\.get\('\/api\/test-mode'/s);
        expect(server).toMatch(/express\.static\(webDistPath, \{ index: false \}\)/);
        expect(shadowRouter).not.toMatch(/\bfetch\s*\(|getValidEbayToken|refreshEbayUserToken|auth_tokens|shopify\/products|ebay\/inventory/);
        expect(shadowRouter).toMatch(/openShadowDatabase/);
        expect(shadowRouter).not.toMatch(/getDb|getRawDb|db\/client/);
        expect(shadowRouter).not.toMatch(/SELECT\s+\*/i);
        expect(authoritativeReader).not.toMatch(/\bfetch\s*\(|auth_tokens|getValidEbayToken|refreshEbayUserToken|db\/client|sync\/|shopify\/products|ebay\/inventory/i);
        expect(authoritativeReader).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER)\s+|\bCREATE\s+TABLE\b/i);
    });
});
