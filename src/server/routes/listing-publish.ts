import { Router, type Request, type Response } from 'express';
import { info, warn } from '../../utils/logger.js';
import { apiPrincipal } from '../middleware/auth.js';
import { createProcessStepRunner, substituteArgv, type StepRunner } from '../order-import-trigger.js';

/**
 * "Publish to eBay" from the operator UI.
 *
 * This handler performs ZERO provider writes. It spawns the standalone
 * listing-lifecycle-admin ceremonies — preflight-create (which prints the
 * manifest digest binding the exact approved draft revision) and then
 * dispatch-create with that digest — exactly the pattern the inventory,
 * order, and fulfillment triggers already use. Every guarantee lives in the
 * ceremony: preflight prerequisites, idempotent intent, single-use approval,
 * one bounded provider chain, post-dispatch reconciliation.
 *
 * The operator's authenticated click IS the one-action approval: the request
 * requires a verified Shopify session for the exact store (the same bar as
 * saving a draft), names one exact catalog row, and binds the exact draft
 * revision digest the operator saw when they clicked.
 *
 * OFF BY DEFAULT: requires PUBLISH_PREFLIGHT_ARGV and PUBLISH_DISPATCH_ARGV
 * (operator-set JSON argv with {catalogId}/{sku}/{revisionDigest}/
 * {manifestDigest} placeholders). Values are substituted only after matching
 * strict grammars, so nothing request-supplied can smuggle an argument.
 */

const EXACT_ROUTE = '/api/listing-publish';
const EXACT_STORE = 'usedcameragear.myshopify.com';
const CATALOG_ID = /^shopify-variant:gid:\/\/shopify\/ProductVariant\/[0-9]+$/u;
const SKU = /^[\x21-\x7e]{1,128}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

/** One publish at a time; a second click while one runs is refused, not queued. */
let publishing = false;

function parseArgvEnv(name: string): readonly string[] | null {
  const raw = process.env[name];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 64
      || !parsed.every((entry) => typeof entry === 'string' && entry.length <= 512)) {
      return null;
    }
    return Object.freeze(parsed as string[]);
  } catch {
    return null;
  }
}

export function createListingPublishRouter(dependencies: Readonly<{
  runStep?: StepRunner;
  preflightArgv?: readonly string[] | null;
  dispatchArgv?: readonly string[] | null;
}> = {}): Router {
  const runStep = dependencies.runStep ?? createProcessStepRunner();
  const preflightArgv = dependencies.preflightArgv !== undefined
    ? dependencies.preflightArgv : parseArgvEnv('PUBLISH_PREFLIGHT_ARGV');
  const dispatchArgv = dependencies.dispatchArgv !== undefined
    ? dependencies.dispatchArgv : parseArgvEnv('PUBLISH_DISPATCH_ARGV');
  const router = Router();

  router.post(EXACT_ROUTE, async (req: Request, res: Response) => {
    try {
      if (req.originalUrl !== EXACT_ROUTE) {
        res.status(403).json({ error: 'Publishing is scoped to the exact route' });
        return;
      }
      const principal = apiPrincipal(req);
      if (principal?.kind !== 'shopify_session' || principal.shopifyStoreDomain !== EXACT_STORE
        || principal.subject === null || principal.actorId !== `shopify-user:${principal.subject}`) {
        res.status(403).json({ error: 'Publishing requires a signed-in Shopify session' });
        return;
      }
      if (preflightArgv === null || dispatchArgv === null) {
        res.status(409).json({
          error: 'Publishing is not armed on the server',
          code: 'PUBLISH_NOT_ARMED',
        });
        return;
      }
      const body = req.body as { catalogId?: unknown; sku?: unknown; revisionDigest?: unknown };
      const catalogId = typeof body?.catalogId === 'string' ? body.catalogId : '';
      const sku = typeof body?.sku === 'string' ? body.sku : '';
      const revisionDigest = typeof body?.revisionDigest === 'string' ? body.revisionDigest : '';
      if (!CATALOG_ID.test(catalogId) || !SKU.test(sku) || !DIGEST.test(revisionDigest)) {
        res.status(400).json({ error: 'catalogId, sku, and revisionDigest are required', code: 'PUBLISH_TARGET_INVALID' });
        return;
      }
      if (publishing) {
        res.status(409).json({ error: 'Another publish is already running', code: 'PUBLISH_BUSY' });
        return;
      }
      publishing = true;
      try {
        info(`[Listing Publish] operator ${principal.actorId} publishing ${sku}`);
        const values = { catalogId, sku, revisionDigest };
        const preflight = await runStep(substituteArgv(preflightArgv, values));
        const manifestDigest = preflight.json?.manifestDigest;
        if (typeof manifestDigest !== 'string' || !DIGEST.test(manifestDigest)) {
          const code = typeof preflight.json?.code === 'string' ? preflight.json.code : 'no-summary';
          warn(`[Listing Publish] preflight refused ${sku}: ${code}`);
          res.status(422).json({ error: 'Preflight refused the draft', code, stage: 'preflight' });
          return;
        }
        const prerequisites = preflight.json?.prerequisites;
        const dispatched = await runStep(
          substituteArgv(dispatchArgv, { ...values, manifestDigest }),
        );
        const status = typeof dispatched.json?.status === 'string' ? dispatched.json.status : 'no-summary';
        if (dispatched.json === null || status === 'denied') {
          const code = typeof dispatched.json?.code === 'string' ? dispatched.json.code : 'no-summary';
          warn(`[Listing Publish] dispatch refused ${sku}: ${code}`);
          res.status(422).json({ error: 'Dispatch refused', code, stage: 'dispatch' });
          return;
        }
        const listingId = typeof dispatched.json?.listingId === 'string' ? dispatched.json.listingId : null;
        const offerId = typeof dispatched.json?.offerId === 'string' ? dispatched.json.offerId : null;
        info(`[Listing Publish] ${sku}: ${status}${listingId ? ` listing ${listingId}` : ''}`);
        res.json({
          schemaVersion: 1,
          status,
          listingId,
          offerId,
          manifestDigest,
          prerequisites: prerequisites ?? null,
        });
      } finally {
        publishing = false;
      }
    } catch {
      publishing = false;
      res.status(500).json({ error: 'Publish failed unexpectedly' });
    }
  });

  return router;
}

export default createListingPublishRouter();
