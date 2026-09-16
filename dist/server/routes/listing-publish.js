import { Router } from 'express';
import { openListingControlStoreReadOnly } from '../../listing-control-store/index.js';
import { info, warn } from '../../utils/logger.js';
import { LISTING_DRAFT_SCOPE } from '../listing-draft-service.js';
import { findUnresolvedListingCreateFromArgv } from '../migration-state-reader.js';
import { apiPrincipal } from '../middleware/auth.js';
import { createProcessStepRunner, substituteArgv } from '../order-import-trigger.js';
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
const RECOVERY_ROUTE = '/api/listing-recovery';
const EXACT_STORE = 'usedcameragear.myshopify.com';
const CATALOG_ID = /^shopify-variant:gid:\/\/shopify\/ProductVariant\/[0-9]+$/u;
const SKU = /^[\x21-\x7e]{1,128}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
/** One publish at a time; a second click while one runs is refused, not queued. */
let publishing = false;
function parseArgvEnv(name) {
    const raw = process.env[name];
    if (typeof raw !== 'string' || raw.trim() === '')
        return null;
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 64
            || !parsed.every((entry) => typeof entry === 'string' && entry.length <= 512)) {
            return null;
        }
        return Object.freeze(parsed);
    }
    catch {
        return null;
    }
}
export function createListingPublishRouter(dependencies = {}) {
    const runStep = dependencies.runStep ?? createProcessStepRunner();
    const refreshCatalog = dependencies.refreshCatalog
        ?? (async () => (await import('../live-listing-catalog-source.js'))
            .getLiveListingCatalogSnapshot.refresh());
    const preflightArgv = dependencies.preflightArgv !== undefined
        ? dependencies.preflightArgv : parseArgvEnv('PUBLISH_PREFLIGHT_ARGV');
    const dispatchArgv = dependencies.dispatchArgv !== undefined
        ? dependencies.dispatchArgv : parseArgvEnv('PUBLISH_DISPATCH_ARGV');
    const reconcileArgv = dependencies.reconcileArgv !== undefined
        ? dependencies.reconcileArgv : parseArgvEnv('PUBLISH_RECONCILE_ARGV');
    const recoverArgv = dependencies.recoverArgv !== undefined
        ? dependencies.recoverArgv : parseArgvEnv('PUBLISH_RECOVER_ARGV');
    const recoverReconcileArgv = dependencies.recoverReconcileArgv !== undefined
        ? dependencies.recoverReconcileArgv : parseArgvEnv('PUBLISH_RECOVER_RECONCILE_ARGV');
    // READ-ONLY ledger lookup for the operator's recovery retry, via the one
    // approved reader (server/migration-state-reader.ts): find the unresolved
    // create job for a SKU. Not a provider write and mounts no writer; every
    // write in the retry still happens inside the armed ceremony CLIs above.
    const lookupUnresolvedCreate = dependencies.lookupUnresolvedCreate
        ?? ((sku) => findUnresolvedListingCreateFromArgv(reconcileArgv, sku));
    const latestRevisionDigest = dependencies.latestRevisionDigest ?? ((catalogId) => {
        const databasePath = process.env.LISTING_CONTROL_DATABASE_PATH;
        if (typeof databasePath !== 'string' || databasePath.length === 0)
            return null;
        try {
            const store = openListingControlStoreReadOnly({ databasePath, expectedScope: LISTING_DRAFT_SCOPE });
            try {
                const revision = store.getLatestRevision(catalogId.replace(/^shopify-variant:/, ''));
                return revision?.revisionDigest ?? null;
            }
            finally {
                store.close();
            }
        }
        catch {
            return null;
        }
    });
    /**
     * Automatic residue cleanup after a failed publish (operator ask,
     * 2026-09-11: "we should just automatically fix this"). Runs the exact
     * ceremony chain an operator would (reconcile -> recover-create ->
     * recover-reconcile), spawned from operator-armed argv templates like
     * preflight/dispatch. Best-effort: any refusal leaves the ledger
     * truthful and reports 'failed' so the operator knows manual recovery
     * is still owed. This server process performs zero provider writes.
     */
    async function cleanUpFailedCreate(input) {
        if (!reconcileArgv || !recoverArgv || !recoverReconcileArgv)
            return 'skipped';
        const jobId = input.dispatchJson.jobId;
        const attemptId = input.dispatchJson.attemptId;
        const intentKey = input.dispatchJson.intentKey;
        const offerId = input.dispatchJson.offerId;
        if (typeof jobId !== 'string' || !SAFE_ID.test(jobId)
            || typeof attemptId !== 'string' || !SAFE_ID.test(attemptId)
            || typeof intentKey !== 'string' || !DIGEST.test(intentKey)
            || typeof offerId !== 'string' || !/^[0-9]{1,19}$/.test(offerId))
            return 'skipped';
        return runResidueRecovery({
            catalogId: input.catalogId,
            sku: input.sku,
            revisionDigest: input.revisionDigest,
            jobId,
            attemptId,
            intentKey,
            evidenceDigest: input.manifestDigest,
            offerId,
        });
    }
    /**
     * The one ceremony chain (reconcile -> recover-create -> recover-reconcile)
     * shared by automatic post-publish cleanup and the operator's manual
     * "clear leftover eBay data" retry. When the caller does not know the
     * residue's offer id (a retry long after the failed dispatch), the
     * reconcile step's own observed offer id is used — the recover ceremony
     * still re-verifies it against the recorded evidence before any DELETE.
     */
    async function runResidueRecovery(input) {
        if (!reconcileArgv || !recoverArgv || !recoverReconcileArgv)
            return 'skipped';
        const values = {
            catalogId: input.catalogId,
            sku: input.sku,
            revisionDigest: input.revisionDigest,
            jobId: input.jobId,
            attemptId: input.attemptId,
            intentKey: input.intentKey,
            evidenceDigest: input.evidenceDigest,
        };
        try {
            const reconciled = await runStep(substituteArgv(reconcileArgv, values));
            if (reconciled.json?.unresolvedCode !== 'CREATE_OFFER_UNPUBLISHED') {
                // Anything else (already resolved, listing actually live, …) is not
                // the residue shape this cleanup handles.
                return 'skipped';
            }
            const observed = reconciled.json?.offerId;
            const offerId = input.offerId
                ?? (typeof observed === 'string' && /^[0-9]{1,19}$/.test(observed) ? observed : null);
            if (offerId === null)
                return 'failed';
            const recovered = await runStep(substituteArgv(recoverArgv, { ...values, offerId }));
            const recoveryJobId = recovered.json?.recoveryJobId;
            const recoveryAttemptId = recovered.json?.recoveryAttemptId;
            if (typeof recoveryJobId !== 'string' || !SAFE_ID.test(recoveryJobId)
                || typeof recoveryAttemptId !== 'string' || !SAFE_ID.test(recoveryAttemptId)) {
                return 'failed';
            }
            const closed = await runStep(substituteArgv(recoverReconcileArgv, {
                ...values, offerId, recoveryJobId, recoveryAttemptId,
            }));
            return closed.json?.status === 'recovered-and-reconciled' ? 'removed' : 'failed';
        }
        catch {
            return 'failed';
        }
    }
    const router = Router();
    router.post(EXACT_ROUTE, async (req, res) => {
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
            const body = req.body;
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
                    const field = typeof preflight.json?.field === 'string' ? preflight.json.field : null;
                    warn(`[Listing Publish] preflight refused ${sku}: ${code}${field ? ` field=${field}` : ''}`);
                    res.status(422).json({ error: 'Preflight refused the draft', code, field, stage: 'preflight' });
                    return;
                }
                const prerequisites = preflight.json?.prerequisites;
                const dispatched = await runStep(substituteArgv(dispatchArgv, { ...values, manifestDigest }));
                const status = typeof dispatched.json?.status === 'string' ? dispatched.json.status : 'no-summary';
                if (dispatched.json === null || status === 'denied') {
                    const code = typeof dispatched.json?.code === 'string' ? dispatched.json.code : 'no-summary';
                    const field = typeof dispatched.json?.field === 'string' ? dispatched.json.field : null;
                    warn(`[Listing Publish] dispatch refused ${sku}: ${code}${field ? ` field=${field}` : ''}`);
                    res.status(422).json({ error: 'Dispatch refused', code, field, stage: 'dispatch' });
                    return;
                }
                const listingId = typeof dispatched.json?.listingId === 'string' ? dispatched.json.listingId : null;
                const offerId = typeof dispatched.json?.offerId === 'string' ? dispatched.json.offerId : null;
                info(`[Listing Publish] ${sku}: ${status}${listingId ? ` listing ${listingId}` : ''}`);
                // TRUTH GATE (2026-09-11 incident): a dispatch that could not verify
                // the listing live on eBay is NOT a success — the first UI publish
                // returned a green "Published" banner while the offer sat
                // UNPUBLISHED. Only a reconciled create with a listing id may report
                // success; anything else is surfaced as unresolved for recovery.
                if (status !== 'created-and-reconciled' || listingId === null) {
                    const rawMessages = dispatched.json?.dispatchFailureEbayErrorMessages;
                    const providerMessages = Array.isArray(rawMessages)
                        ? rawMessages.filter((entry) => typeof entry === 'string').slice(0, 2)
                        : [];
                    warn(`[Listing Publish] ${sku}: unresolved dispatch (${status})`
                        + (providerMessages.length ? ` — ${providerMessages.join(' / ')}` : ''));
                    const cleanup = dispatched.json === null
                        ? 'skipped'
                        : await cleanUpFailedCreate({
                            catalogId, sku, revisionDigest, manifestDigest,
                            dispatchJson: dispatched.json,
                        });
                    info(`[Listing Publish] ${sku}: residue cleanup ${cleanup}`);
                    const cleanupNote = cleanup === 'removed'
                        ? ' Leftover eBay data from this attempt was cleaned up automatically.'
                        : ' Leftover eBay draft data may remain; the item can show Fix needed until it is cleared.';
                    res.status(502).json({
                        error: (providerMessages.length
                            ? `eBay refused the listing: ${providerMessages.join(' ')}`
                            : 'eBay accepted the upload but the listing could not be confirmed live')
                            + cleanupNote,
                        code: 'PUBLISH_UNRESOLVED',
                        stage: 'dispatch',
                        status,
                        providerMessages,
                        cleanup,
                    });
                    return;
                }
                // Fire-and-forget so the catalog reflects the new listing without
                // waiting for the next census; the client polls the workspace.
                void refreshCatalog().catch(() => undefined);
                res.json({
                    schemaVersion: 1,
                    status,
                    listingId,
                    offerId,
                    manifestDigest,
                    prerequisites: prerequisites ?? null,
                });
            }
            finally {
                publishing = false;
            }
        }
        catch {
            publishing = false;
            res.status(500).json({ error: 'Publish failed unexpectedly' });
        }
    });
    // Operator retry for a failed publish's leftover eBay data. The automatic
    // cleanup above is best-effort; when it fails (a throttled capture, a
    // provider read lag) the item shows "Fix needed", the draft stays locked
    // behind the residue guard, and before this route the only way out was an
    // engineer running the ceremonies by hand. Same session bar as publishing;
    // all provider writes still happen inside the armed ceremony CLIs.
    router.post(RECOVERY_ROUTE, async (req, res) => {
        try {
            if (req.originalUrl !== RECOVERY_ROUTE) {
                res.status(403).json({ error: 'Recovery is scoped to the exact route' });
                return;
            }
            const principal = apiPrincipal(req);
            if (principal?.kind !== 'shopify_session' || principal.shopifyStoreDomain !== EXACT_STORE
                || principal.subject === null || principal.actorId !== `shopify-user:${principal.subject}`) {
                res.status(403).json({ error: 'Recovery requires a signed-in Shopify session' });
                return;
            }
            if (reconcileArgv === null || recoverArgv === null || recoverReconcileArgv === null) {
                res.status(409).json({
                    error: 'Recovery is not armed on the server',
                    code: 'RECOVERY_NOT_ARMED',
                });
                return;
            }
            const body = req.body;
            const catalogId = typeof body?.catalogId === 'string' ? body.catalogId : '';
            const sku = typeof body?.sku === 'string' ? body.sku : '';
            if (!CATALOG_ID.test(catalogId) || !SKU.test(sku)) {
                res.status(400).json({ error: 'catalogId and sku are required', code: 'RECOVERY_TARGET_INVALID' });
                return;
            }
            if (publishing) {
                res.status(409).json({ error: 'Another publish is already running', code: 'PUBLISH_BUSY' });
                return;
            }
            publishing = true;
            try {
                const source = lookupUnresolvedCreate(sku);
                if (source === null) {
                    res.status(404).json({
                        error: 'No unresolved eBay create found for this item — nothing to recover.',
                        code: 'RECOVERY_NOTHING_UNRESOLVED',
                    });
                    return;
                }
                const revisionDigest = latestRevisionDigest(catalogId);
                if (revisionDigest === null) {
                    res.status(409).json({
                        error: 'The saved draft for this item could not be read.',
                        code: 'RECOVERY_DRAFT_UNAVAILABLE',
                    });
                    return;
                }
                info(`[Listing Publish] operator ${principal.actorId} recovering ${sku} (${source.jobId})`);
                const status = await runResidueRecovery({ catalogId, sku, revisionDigest, ...source });
                info(`[Listing Publish] ${sku}: operator recovery ${status}`);
                if (status === 'removed')
                    void refreshCatalog().catch(() => undefined);
                res.status(status === 'removed' ? 200 : 502).json({
                    schemaVersion: 1,
                    status,
                    ...(status === 'removed' ? {} : {
                        error: status === 'skipped'
                            ? 'The leftover data is not in the expected state — it may already be cleared, or the listing is actually live. Refresh and check again.'
                            : 'Recovery could not complete this time (often a temporary provider limit). Wait a minute and try again.',
                        code: 'RECOVERY_UNRESOLVED',
                    }),
                });
            }
            finally {
                publishing = false;
            }
        }
        catch (error) {
            warn(`[Listing Publish] recovery failed: ${error instanceof Error ? error.message : 'unknown'}`);
            res.status(500).json({ error: 'Recovery failed unexpectedly' });
        }
    });
    return router;
}
export default createListingPublishRouter();
