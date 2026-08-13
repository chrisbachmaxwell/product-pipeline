import http from 'node:http';
import express from 'express';
import { describe, expect, it, vi } from 'vitest';
import { createShopifyWebhookRouter } from './shopify-webhooks.js';
async function postWebhook(router) {
    const app = express();
    app.use(router);
    const server = http.createServer(app);
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    try {
        const address = server.address();
        if (!address || typeof address === 'string')
            throw new Error('address unavailable');
        return await new Promise((resolve, reject) => {
            const request = http.request({
                hostname: '127.0.0.1',
                port: address.port,
                path: '/webhooks/shopify/products-update',
                method: 'POST',
            }, (response) => {
                response.resume();
                response.on('end', () => resolve(response.statusCode ?? 0));
            });
            request.on('error', reject);
            request.end();
        });
    }
    finally {
        await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
    }
}
describe('Shopify listing evidence invalidation', () => {
    it('refreshes only after a verified webhook and performs no mutation dispatch', async () => {
        const refreshListings = vi.fn(async () => undefined);
        const verified = createShopifyWebhookRouter({
            verify: async () => true,
            refreshListings,
        });
        expect(await postWebhook(verified)).toBe(200);
        await vi.waitFor(() => expect(refreshListings).toHaveBeenCalledOnce());
        refreshListings.mockClear();
        const denied = createShopifyWebhookRouter({
            verify: async () => false,
            refreshListings,
        });
        expect(await postWebhook(denied)).toBe(200);
        expect(refreshListings).not.toHaveBeenCalled();
    });
});
