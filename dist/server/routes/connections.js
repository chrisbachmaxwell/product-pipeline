import { Router } from 'express';
import { apiPrincipal } from '../middleware/auth.js';
import { sendIncidentEmail, smtpConfigFromVaultJson, } from '../incident-email.js';
import { deleteStoredAnthropicKey, deleteStoredEmailConfig, readStoredEmailConfigJson, storeEmailConfigJson, deleteStoredGithubToken, getAnthropicConnectionStatus, getGithubConnectionStatus, isPlausibleAnthropicKey, isPlausibleGithubToken, storeAnthropicKey, storeGithubToken, validateAnthropicKey, validateGithubToken, } from '../connections.js';
/**
 * Settings → Connections (L79). POST validates the pasted key LIVE against
 * the provider before storing it in the app's credential vault; the key is
 * never echoed, never logged, and appears in no response. Local credential
 * writes only — zero commerce-provider writes on any path.
 */
const EXACT_STORE = 'usedcameragear.myshopify.com';
export function createConnectionsRouter(dependencies = {}) {
    const providers = {
        anthropic: {
            route: '/api/connections/anthropic',
            shapeError: 'That does not look like an Anthropic API key (they start with sk-ant-).',
            rejectedError: 'Anthropic rejected this key. Copy a fresh one from console.anthropic.com and try again.',
            isPlausible: isPlausibleAnthropicKey,
            validate: dependencies.validate ?? validateAnthropicKey,
            store: dependencies.store ?? storeAnthropicKey,
            remove: dependencies.remove ?? deleteStoredAnthropicKey,
            status: dependencies.status ?? getAnthropicConnectionStatus,
        },
        github: {
            route: '/api/connections/github',
            shapeError: 'That does not look like a GitHub token (fine-grained tokens start with github_pat_).',
            rejectedError: 'GitHub rejected this token or it cannot see the ProductPipeline repository — check the token\u2019s repository access and Issues permission.',
            isPlausible: isPlausibleGithubToken,
            validate: dependencies.githubValidate ?? validateGithubToken,
            store: dependencies.githubStore ?? storeGithubToken,
            remove: dependencies.githubRemove ?? deleteStoredGithubToken,
            status: dependencies.githubStatus ?? getGithubConnectionStatus,
        },
    };
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
    const emailStatus = dependencies.emailStatus ?? (() => {
        const armedByEnv = (process.env.INCIDENT_SMTP_HOST ?? '') !== ''
            && (process.env.INCIDENT_EMAIL_TO ?? '') !== '';
        if (armedByEnv)
            return { connected: true, source: 'env', to: null };
        const config = smtpConfigFromVaultJson(readStoredEmailConfigJson());
        return config === null
            ? { connected: false, source: null, to: null }
            : { connected: true, source: 'stored', to: [...config.to] };
    });
    const emailTestSend = dependencies.emailTestSend ?? sendIncidentEmail;
    const emailStore = dependencies.emailStore ?? storeEmailConfigJson;
    const emailRemove = dependencies.emailRemove ?? deleteStoredEmailConfig;
    const statuses = () => ({
        schemaVersion: 1,
        anthropic: providers.anthropic.status(),
        github: providers.github.status(),
        email: emailStatus(),
    });
    router.get('/api/connections', (req, res) => {
        if (!gate(req, res))
            return;
        res.json(statuses());
    });
    for (const provider of Object.values(providers)) {
        router.post(provider.route, async (req, res) => {
            if (req.originalUrl !== provider.route) {
                res.status(403).json({ error: 'Connections are scoped to the exact route' });
                return;
            }
            if (!gate(req, res))
                return;
            const apiKey = req.body?.apiKey;
            if (!provider.isPlausible(apiKey)) {
                res.status(400).json({ error: provider.shapeError, code: 'CONNECTION_KEY_SHAPE' });
                return;
            }
            const verdict = await provider.validate(apiKey);
            if (verdict === 'unauthorized') {
                res.status(422).json({ error: provider.rejectedError, code: 'CONNECTION_KEY_REJECTED' });
                return;
            }
            if (verdict === 'unreachable') {
                res.status(502).json({
                    error: 'Could not reach the provider to verify — try again in a minute.',
                    code: 'CONNECTION_VERIFY_UNREACHABLE',
                });
                return;
            }
            if (!provider.store(apiKey)) {
                res.status(500).json({ error: 'The key verified but could not be saved.', code: 'CONNECTION_STORE_FAILED' });
                return;
            }
            res.json(statuses());
        });
        router.delete(provider.route, (req, res) => {
            if (!gate(req, res))
                return;
            if (provider.status().source === 'env') {
                res.status(409).json({
                    error: 'This connection is set by the server environment and cannot be disconnected from the app.',
                    code: 'CONNECTION_ENV_MANAGED',
                });
                return;
            }
            provider.remove();
            res.json(statuses());
        });
    }
    const EMAIL_ROUTE = '/api/connections/email';
    router.post(EMAIL_ROUTE, async (req, res) => {
        if (req.originalUrl !== EMAIL_ROUTE) {
            res.status(403).json({ error: 'Connections are scoped to the exact route' });
            return;
        }
        if (!gate(req, res))
            return;
        const body = req.body;
        const candidate = smtpConfigFromVaultJson(JSON.stringify({
            user: body?.address,
            pass: body?.appPassword,
            to: typeof body?.recipients === 'string'
                ? body.recipients.split(',').map((value) => value.trim()).filter(Boolean)
                : body?.recipients,
        }));
        if (candidate === null) {
            res.status(400).json({
                error: 'Need a valid sending address, an app password, and at least one recipient email.',
                code: 'CONNECTION_KEY_SHAPE',
            });
            return;
        }
        // Live validation IS a test email — if it lands, the settings work.
        const delivered = await emailTestSend({
            severity: 'info',
            title: 'ProductPipeline alert emails are connected',
            detail: 'This is the connection test. Critical sync incidents will arrive at this address within minutes of detection.',
            diagnosis: null,
            githubIssueUrl: null,
            detectedAtUtc: new Date().toISOString(),
        }, candidate);
        if (!delivered) {
            res.status(422).json({
                error: 'The test email could not be sent — check the address and app password '
                    + '(Google → Security → 2-Step Verification → App passwords).',
                code: 'CONNECTION_KEY_REJECTED',
            });
            return;
        }
        if (!emailStore(JSON.stringify({
            user: candidate.user, pass: candidate.pass, to: candidate.to,
        }))) {
            res.status(500).json({ error: 'The test email sent but settings could not be saved.', code: 'CONNECTION_STORE_FAILED' });
            return;
        }
        res.json(statuses());
    });
    router.delete(EMAIL_ROUTE, (req, res) => {
        if (!gate(req, res))
            return;
        if (emailStatus().source === 'env') {
            res.status(409).json({
                error: 'This connection is set by the server environment and cannot be disconnected from the app.',
                code: 'CONNECTION_ENV_MANAGED',
            });
            return;
        }
        emailRemove();
        res.json(statuses());
    });
    return router;
}
export default createConnectionsRouter();
