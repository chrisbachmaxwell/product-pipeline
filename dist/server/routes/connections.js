import { Router } from 'express';
import { apiPrincipal } from '../middleware/auth.js';
import { deleteStoredAnthropicKey, getAnthropicConnectionStatus, isPlausibleAnthropicKey, storeAnthropicKey, validateAnthropicKey, } from '../connections.js';
/**
 * Settings → Connections (L79). POST validates the pasted key LIVE against
 * the provider before storing it in the app's credential vault; the key is
 * never echoed, never logged, and appears in no response. Local credential
 * writes only — zero commerce-provider writes on any path.
 */
const EXACT_ROUTE = '/api/connections/anthropic';
const EXACT_STORE = 'usedcameragear.myshopify.com';
export function createConnectionsRouter(dependencies = {}) {
    const validate = dependencies.validate ?? validateAnthropicKey;
    const store = dependencies.store ?? storeAnthropicKey;
    const remove = dependencies.remove ?? deleteStoredAnthropicKey;
    const status = dependencies.status ?? getAnthropicConnectionStatus;
    const router = Router();
    const gate = (req, res) => {
        const principal = apiPrincipal(req);
        if (principal?.kind !== 'shopify_session' || principal.shopifyStoreDomain !== EXACT_STORE
            || principal.subject === null) {
            res.status(403).json({ error: 'Requires a signed-in Shopify session' });
            return false;
        }
        return true;
    };
    router.get('/api/connections', (req, res) => {
        if (!gate(req, res))
            return;
        res.json({ schemaVersion: 1, anthropic: status() });
    });
    router.post(EXACT_ROUTE, async (req, res) => {
        if (req.originalUrl !== EXACT_ROUTE) {
            res.status(403).json({ error: 'Connections are scoped to the exact route' });
            return;
        }
        if (!gate(req, res))
            return;
        const apiKey = req.body?.apiKey;
        if (!isPlausibleAnthropicKey(apiKey)) {
            res.status(400).json({
                error: 'That does not look like an Anthropic API key (they start with sk-ant-).',
                code: 'CONNECTION_KEY_SHAPE',
            });
            return;
        }
        const verdict = await validate(apiKey);
        if (verdict === 'unauthorized') {
            res.status(422).json({
                error: 'Anthropic rejected this key. Copy a fresh one from console.anthropic.com and try again.',
                code: 'CONNECTION_KEY_REJECTED',
            });
            return;
        }
        if (verdict === 'unreachable') {
            res.status(502).json({
                error: 'Could not reach Anthropic to verify the key — try again in a minute.',
                code: 'CONNECTION_VERIFY_UNREACHABLE',
            });
            return;
        }
        if (!store(apiKey)) {
            res.status(500).json({ error: 'The key verified but could not be saved.', code: 'CONNECTION_STORE_FAILED' });
            return;
        }
        res.json({ schemaVersion: 1, anthropic: status() });
    });
    router.delete(EXACT_ROUTE, (req, res) => {
        if (!gate(req, res))
            return;
        if (status().source === 'env') {
            res.status(409).json({
                error: 'This connection is set by the server environment and cannot be disconnected from the app.',
                code: 'CONNECTION_ENV_MANAGED',
            });
            return;
        }
        remove();
        res.json({ schemaVersion: 1, anthropic: status() });
    });
    return router;
}
export default createConnectionsRouter();
