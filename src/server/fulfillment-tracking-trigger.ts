import { info, warn } from '../utils/logger.js';
import { createProcessStepRunner, substituteArgv, type StepRunner } from './order-import-trigger.js';

/**
 * Automated tracking dispatch: when a post-cutover eBay order ships in
 * Shopify (fulfilled with a tracking number, the operator's normal
 * workflow), push that tracking to eBay through the fulfillment-tracking
 * ceremonies -- discover -> preflight -> dispatch -- exactly as run
 * supervised. This replaces the last thing Marketplace Connect did.
 *
 * The trigger decides only WHEN the ceremonies run. Discovery deliberately
 * over-reports (any shipped eBay-tagged order); the dispatch ceremony is the
 * authority and quietly refuses incumbent-era orders
 * (FULFILLMENT_ORDER_LINK_REQUIRED) and repeats
 * (FULFILLMENT_INTENT_ALREADY_RECORDED) -- both are expected outcomes, not
 * failures.
 *
 * OFF BY DEFAULT: requires FULFILLMENT_DISCOVER_ARGV,
 * FULFILLMENT_PREFLIGHT_ARGV ({ebayOrderId}/{shopifyOrderGid}/
 * {fulfillmentGid} placeholders), and FULFILLMENT_DISPATCH_ARGV (adds
 * {manifestDigest}). Values substituted into argv only after matching strict
 * grammars.
 */

const EBAY_ORDER_ID = /^[0-9]{2}-[0-9]{5}-[0-9]{5,8}$/u;
const ORDER_GID = /^gid:\/\/shopify\/Order\/[0-9]+$/u;
const FULFILLMENT_GID = /^gid:\/\/shopify\/Fulfillment\/[0-9]+$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

const DEFAULT_POLL_INTERVAL_MS = 10 * 60_000;
const MAX_DISPATCHES_PER_CYCLE = 10;
/** Denials that mean "nothing to do", never logged as failures. */
const EXPECTED_SKIP_CODES: readonly string[] = Object.freeze([
  'FULFILLMENT_ORDER_LINK_REQUIRED',
  'FULFILLMENT_INTENT_ALREADY_RECORDED',
]);

function parseArgvEnv(name: string, env: NodeJS.ProcessEnv): readonly string[] | null {
  const raw = env[name];
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

export function createFulfillmentTrackingTrigger(dependencies: Readonly<{
  runStep?: StepRunner;
  discoverArgv?: readonly string[] | null;
  preflightArgv?: readonly string[] | null;
  dispatchArgv?: readonly string[] | null;
  pollIntervalMs?: number;
  setTicker?: (callback: () => void, ms: number) => unknown;
}> = {}) {
  const env = process.env;
  const runStep = dependencies.runStep ?? createProcessStepRunner();
  const discoverArgv = dependencies.discoverArgv !== undefined
    ? dependencies.discoverArgv : parseArgvEnv('FULFILLMENT_DISCOVER_ARGV', env);
  const preflightArgv = dependencies.preflightArgv !== undefined
    ? dependencies.preflightArgv : parseArgvEnv('FULFILLMENT_PREFLIGHT_ARGV', env);
  const dispatchArgv = dependencies.dispatchArgv !== undefined
    ? dependencies.dispatchArgv : parseArgvEnv('FULFILLMENT_DISPATCH_ARGV', env);
  const pollIntervalMs = dependencies.pollIntervalMs
    ?? (Number.isFinite(Number(env.FULFILLMENT_POLL_INTERVAL_MINUTES))
      && Number(env.FULFILLMENT_POLL_INTERVAL_MINUTES) >= 1
      && Number(env.FULFILLMENT_POLL_INTERVAL_MINUTES) <= 120
      ? Number(env.FULFILLMENT_POLL_INTERVAL_MINUTES) * 60_000
      : DEFAULT_POLL_INTERVAL_MS);
  const setTicker = dependencies.setTicker
    ?? ((callback: () => void, ms: number) => setInterval(callback, ms).unref?.());

  const armed = discoverArgv !== null && preflightArgv !== null && dispatchArgv !== null;
  let running = false;

  async function runCycle(): Promise<void> {
    if (!armed || running) return;
    running = true;
    try {
      const discovered = await runStep(discoverArgv as readonly string[]);
      if (discovered.json === null) {
        warn('FULFILLMENT_DISCOVER_FAILED: produced no summary');
        return;
      }
      const candidates = (Array.isArray(discovered.json.candidates)
        ? discovered.json.candidates as Array<Record<string, unknown>>
        : [])
        .filter((entry) => typeof entry?.ebayOrderId === 'string'
          && EBAY_ORDER_ID.test(entry.ebayOrderId as string)
          && typeof entry?.shopifyOrderGid === 'string'
          && ORDER_GID.test(entry.shopifyOrderGid as string)
          && typeof entry?.shopifyFulfillmentGid === 'string'
          && FULFILLMENT_GID.test(entry.shopifyFulfillmentGid as string))
        .slice(0, MAX_DISPATCHES_PER_CYCLE);
      for (const candidate of candidates) {
        const values = {
          ebayOrderId: candidate.ebayOrderId as string,
          shopifyOrderGid: candidate.shopifyOrderGid as string,
          fulfillmentGid: candidate.shopifyFulfillmentGid as string,
        };
        const preflight = await runStep(
          substituteArgv(preflightArgv as readonly string[], values),
        );
        const manifestDigest = preflight.json?.manifestDigest;
        if (typeof manifestDigest !== 'string' || !DIGEST.test(manifestDigest)) {
          const code = typeof preflight.json?.code === 'string' ? preflight.json.code : 'no-summary';
          if (!EXPECTED_SKIP_CODES.includes(code)) {
            warn(`FULFILLMENT_PREFLIGHT_FAILED: ${values.ebayOrderId} ${code}`);
          }
          continue;
        }
        const dispatched = await runStep(
          substituteArgv(dispatchArgv as readonly string[], { ...values, manifestDigest }),
        );
        const status = typeof dispatched.json?.status === 'string' ? dispatched.json.status : 'no-summary';
        const code = typeof dispatched.json?.code === 'string' ? dispatched.json.code : '';
        if (status === 'denied' && EXPECTED_SKIP_CODES.includes(code)) continue;
        if (status === 'denied' || dispatched.json === null) {
          warn(`FULFILLMENT_DISPATCH_FAILED: ${values.ebayOrderId} ${code || 'no-summary'}`);
          continue;
        }
        info(`[Fulfillment Tracking] ${values.ebayOrderId}: ${status}`);
      }
    } finally {
      running = false;
    }
  }

  return {
    startSchedule(): void {
      if (!armed) return;
      setTicker(() => { void runCycle(); }, pollIntervalMs);
    },
    runCycle,
    armed,
  };
}

export const fulfillmentTrackingTrigger = createFulfillmentTrackingTrigger();
