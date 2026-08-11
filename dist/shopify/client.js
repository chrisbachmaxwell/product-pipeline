import { Session, shopifyApi } from '@shopify/shopify-api';
import '@shopify/shopify-api/adapters/node';
import { loadShopifyCredentials } from '../config/credentials.js';
export const createShopifyApi = async () => {
    const shopify = await loadShopifyCredentials();
    return shopifyApi({
        apiKey: shopify.clientId,
        apiSecretKey: shopify.clientSecret,
        scopes: ['read_products', 'read_inventory', 'read_orders', 'read_fulfillments'],
        hostName: shopify.storeDomain,
        apiVersion: (process.env.SHOPIFY_API_VERSION ?? '2024-01'),
        isEmbeddedApp: false,
    });
};
export const createShopifyGraphqlClient = async (accessToken) => {
    const shopify = await loadShopifyCredentials();
    const api = await createShopifyApi();
    const session = new Session({
        id: `offline_${shopify.storeDomain}`,
        shop: shopify.storeDomain,
        state: 'ebaysync',
        isOnline: false,
        accessToken,
    });
    return new api.clients.Graphql({ session });
};
export const requestShopifyClientCredentialsToken = async () => {
    const shopify = await loadShopifyCredentials();
    const response = await fetch(`https://${shopify.storeDomain}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_id: shopify.clientId,
            client_secret: shopify.clientSecret,
            grant_type: 'client_credentials',
        }),
    });
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Shopify token request failed (${response.status}): ${body}`);
    }
    const payload = (await response.json());
    if (!payload.access_token) {
        throw new Error('Shopify token response missing access_token');
    }
    return payload.access_token;
};
