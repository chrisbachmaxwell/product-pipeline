import { Router } from 'express';
import { loadShopifyCredentials } from '../../config/credentials.js';
import { getRawDb } from '../../db/client.js';
import { info, error as logError } from '../../utils/logger.js';
const router = Router();
router.get('/auth', async (req, res) => {
    try {
        const creds = await loadShopifyCredentials();
        const shop = req.query.shop || creds.storeDomain;
        const proto = req.get('x-forwarded-proto') || req.protocol;
        const appUrl = `${proto}://${req.get('host')}`;
        const redirectUri = `${appUrl}/auth/callback`;
        const scopes = [
            'read_products',
            'read_inventory',
            'read_orders',
            'read_fulfillments',
        ].join(',');
        const nonce = crypto.randomUUID();
        const authUrl = `https://${shop}/admin/oauth/authorize?` +
            `client_id=${creds.clientId}` +
            `&scope=${scopes}` +
            `&redirect_uri=${encodeURIComponent(redirectUri)}` +
            `&state=${nonce}`;
        info(`[Shopify Auth] Redirecting to: ${authUrl}`);
        res.redirect(authUrl);
    }
    catch (err) {
        logError(`[Shopify Auth] Error: ${err}`);
        res.status(500).json({ error: 'Auth initialization failed' });
    }
});
router.get('/auth/callback', async (req, res) => {
    try {
        const { code, shop } = req.query;
        if (!code || !shop) {
            res.status(400).json({ error: 'Missing code or shop parameter' });
            return;
        }
        const creds = await loadShopifyCredentials();
        const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: creds.clientId,
                client_secret: creds.clientSecret,
                code: code,
            }),
        });
        if (!tokenResponse.ok) {
            const errText = await tokenResponse.text();
            logError(`[Shopify Auth] Token exchange failed: ${errText}`);
            res.status(500).json({ error: 'Token exchange failed' });
            return;
        }
        const tokenData = (await tokenResponse.json());
        const accessToken = tokenData.access_token;
        const db = await getRawDb();
        const existing = db.prepare(`SELECT * FROM auth_tokens WHERE platform = 'shopify'`).get();
        if (existing) {
            db.prepare(`UPDATE auth_tokens SET access_token = ?, scope = ?, updated_at = unixepoch() WHERE platform = 'shopify'`).run(accessToken, tokenData.scope);
        }
        else {
            db.prepare(`INSERT INTO auth_tokens (platform, access_token, scope, created_at, updated_at) VALUES ('shopify', ?, ?, unixepoch(), unixepoch())`).run(accessToken, tokenData.scope);
        }
        info(`[Shopify Auth] Authenticated with ${shop}. Scopes: ${tokenData.scope}`);
        res.send(`
      <html><body style="font-family:system-ui;padding:40px;text-align:center">
        <h1>✅ ProductPipeline Connected!</h1>
        <p>Authenticated with ${shop}</p>
        <p>Scopes: ${tokenData.scope}</p>
        <p>You can close this window.</p>
      </body></html>
    `);
    }
    catch (err) {
        logError(`[Shopify Auth] Callback error: ${err}`);
        res.status(500).json({ error: 'Auth callback failed' });
    }
});
export default router;
