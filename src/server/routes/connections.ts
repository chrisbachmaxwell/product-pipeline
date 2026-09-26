import { Router, type Request, type Response } from 'express';
import { apiPrincipal } from '../middleware/auth.js';
import {
  deleteStoredAnthropicKey,
  deleteStoredGithubToken,
  getAnthropicConnectionStatus,
  getGithubConnectionStatus,
  isPlausibleAnthropicKey,
  isPlausibleGithubToken,
  storeAnthropicKey,
  storeGithubToken,
  validateAnthropicKey,
  validateGithubToken,
} from '../connections.js';

/**
 * Settings → Connections (L79). POST validates the pasted key LIVE against
 * the provider before storing it in the app's credential vault; the key is
 * never echoed, never logged, and appears in no response. Local credential
 * writes only — zero commerce-provider writes on any path.
 */
const EXACT_STORE = 'usedcameragear.myshopify.com';

type Provider = Readonly<{
  route: string;
  shapeError: string;
  rejectedError: string;
  isPlausible: (value: unknown) => value is string;
  validate: (secret: string) => Promise<'valid' | 'unauthorized' | 'unreachable'>;
  store: (secret: string) => boolean;
  remove: () => boolean;
  status: () => { connected: boolean; source: 'env' | 'stored' | null };
}>;

export function createConnectionsRouter(dependencies: Readonly<{
  validate?: typeof validateAnthropicKey;
  store?: typeof storeAnthropicKey;
  remove?: typeof deleteStoredAnthropicKey;
  status?: typeof getAnthropicConnectionStatus;
  githubValidate?: typeof validateGithubToken;
  githubStore?: typeof storeGithubToken;
  githubRemove?: typeof deleteStoredGithubToken;
  githubStatus?: typeof getGithubConnectionStatus;
}> = {}): Router {
  const providers: Record<string, Provider> = {
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

  const gate = (req: Request, res: Response): boolean => {
    const principal = apiPrincipal(req);
    if (principal?.kind !== 'shopify_session' || principal.shopifyStoreDomain !== EXACT_STORE
      || principal.subject === null) {
      res.status(403).json({ error: 'Requires a signed-in Shopify session' });
      return false;
    }
    return true;
  };

  const statuses = () => ({
    schemaVersion: 1,
    anthropic: providers.anthropic!.status(),
    github: providers.github!.status(),
  });

  router.get('/api/connections', (req: Request, res: Response) => {
    if (!gate(req, res)) return;
    res.json(statuses());
  });

  for (const provider of Object.values(providers)) {
    router.post(provider.route, async (req: Request, res: Response) => {
      if (req.originalUrl !== provider.route) {
        res.status(403).json({ error: 'Connections are scoped to the exact route' });
        return;
      }
      if (!gate(req, res)) return;
      const apiKey = (req.body as { apiKey?: unknown } | undefined)?.apiKey;
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

    router.delete(provider.route, (req: Request, res: Response) => {
      if (!gate(req, res)) return;
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

  return router;
}

export default createConnectionsRouter();
