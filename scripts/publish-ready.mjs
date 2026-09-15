// Ready-queue publisher. Runs ON the Railway box (via scripts/publish-ready.sh)
// against /app/dist. For every readyToList row: ensure a draft revision
// exists (rebase save when missing), then preflight -> paced dispatch ->
// patient reconcile. Encodes the L63/L64-era operational laws:
//   - 40s between preflight and dispatch, 60s between items (Shopify rate
//     budget; each ceremony captures the full store)
//   - eBay read-lag: with a listing id in hand, retry reconcile patiently
//   - transient catch-all denials retry once with a fresh preflight
//   - KNOWN-benign blockers (missing condition tag, eBay-illegal SKU) are
//     per-item SKIPs, never queue halts; unknown shapes still halt loudly
// Zero provider writes happen in this process: dispatch/preflight/reconcile
// are the standalone ceremony CLIs, spawned exactly as the armed publish
// route spawns them.
import { execFile } from 'node:child_process';
import Database from '/app/node_modules/better-sqlite3/lib/index.js';
import { createListingDraftService } from '/app/dist/server/listing-draft-service.js';
import { getLiveListingCatalogSnapshot } from '/app/dist/server/live-listing-catalog-source.js';

const STORE = '/data/migration-state/product-pipeline-migration-v1.sqlite';
const CONTROL = '/data/product-pipeline/listing-control.sqlite';
const CLI = 'dist/listing-lifecycle-admin/index.js';
const SKU_GRAMMAR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const NEVER_PUBLISH = new Set(['PIPELINE-TEST-20260826']);

function run(argv) {
  return new Promise((resolve) => {
    execFile(process.execPath, argv, {
      cwd: '/app', timeout: 180000, maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      let json = null;
      for (const line of (stdout + '\n' + stderr).split('\n').reverse()) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed && typeof parsed.command === 'string') { json = parsed; break; }
          if (json === null) json = parsed;
        } catch { /* keep scanning */ }
      }
      resolve(json);
    });
  });
}
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const transient = (result) => !result || result.code === 'LISTING_LIFECYCLE_DENIED';

const snapshot = await getLiveListingCatalogSnapshot.refresh();
const ready = snapshot.rows.filter((row) => row.readyToList
  && !NEVER_PUBLISH.has(row.shopify.sku));
console.log('READY', ready.length, 'snapshot', snapshot.observedAtUtc);

const service = createListingDraftService();
let live = 0;
let skipped = 0;
for (const row of ready) {
  const sku = row.shopify.sku;
  if (!SKU_GRAMMAR.test(sku)) {
    console.log('SKIP', sku, 'SKU_ILLEGAL_FOR_EBAY (rename in Shopify)');
    skipped += 1;
    continue;
  }
  if (row.readyToListGaps && row.readyToListGaps.includes('condition')) {
    console.log('SKIP', sku, 'CONDITION_TAG_MISSING (tag in Shopify)');
    skipped += 1;
    continue;
  }

  // Ensure a draft revision exists; new ready items get a pure-inherit save
  // (auto-defaults fill everything derivable).
  const controlDb = new Database(CONTROL, { readonly: true });
  let revision = controlDb.prepare(
    'SELECT revision_digest FROM listing_revisions WHERE raw_sku = ? ORDER BY revision_number DESC LIMIT 1',
  ).get(sku);
  controlDb.close();
  if (!revision) {
    try {
      const dto = await service.get(row.id);
      const chart = dto.sections.listing.conditionDescription.shopify;
      const note = ((chart ? chart + ' ' : '')
        + 'The photographs show the exact item for sale.').slice(0, 1000);
      const saved = await service.save({
        schemaVersion: 1,
        action: 'save_local_draft',
        catalogId: row.id,
        expectedRevisionDigest: null,
        base: { sourceDigest: dto.base.sourceDigest, ebayDigest: dto.base.ebayDigest },
        draft: {
          title: null, category: null, condition: null,
          conditionDescription: note,
          description: null, images: null, itemSpecifics: null,
          fulfillmentPolicyId: null, paymentPolicyId: null,
          returnPolicyId: null, merchantLocation: null,
        },
      }, 'auto-publish-ready');
      revision = { revision_digest: saved.revision.revisionDigest };
      console.log('DRAFTED', sku, 'rev', saved.revision.revisionNumber);
    } catch (error) {
      console.log('SKIP', sku, 'DRAFT_SAVE_FAILED',
        String((error && error.code) || error).slice(0, 50));
      skipped += 1;
      continue;
    }
  }

  const target = ['--catalog-id', row.id, '--sku', sku,
    '--revision-digest', revision.revision_digest,
    '--description-template', 'ucg-branded-v2'];

  let dispatched = null;
  let benignSkip = null;
  for (let attempt = 0; attempt < 2 && !dispatched && !benignSkip; attempt += 1) {
    if (attempt > 0) await sleep(90000);
    const preflight = await run([CLI, 'preflight-create', ...target]);
    if (!preflight || preflight.status !== 'preview') {
      if (preflight && preflight.code === 'CREATE_REQUIRED_FIELD_MISSING') {
        benignSkip = 'MISSING_' + String(preflight.field || 'field').toUpperCase();
        break;
      }
      if (preflight && preflight.code === 'CREATE_TARGET_ALREADY_LISTED') {
        benignSkip = 'ALREADY_LISTED';
        break;
      }
      if (transient(preflight) && attempt === 0) continue;
      console.log('HALT', sku, 'PREFLIGHT', JSON.stringify(preflight).slice(0, 250));
      process.exit(1);
    }
    await sleep(40000);
    const result = await run([CLI, 'dispatch-create', ...target,
      '--manifest-digest', preflight.manifestDigest, '--migration-store', STORE]);
    if (!result || result.status === 'denied') {
      if (transient(result) && attempt === 0) continue;
      if (result && result.code === 'CREATE_INTENT_ALREADY_RECORDED') {
        benignSkip = 'INTENT_ALREADY_RECORDED';
        break;
      }
      console.log('HALT', sku, 'DISPATCH', JSON.stringify(result).slice(0, 250));
      process.exit(1);
    }
    dispatched = result;
  }
  if (benignSkip) {
    console.log('SKIP', sku, benignSkip);
    skipped += 1;
    await sleep(20000);
    continue;
  }
  if (!dispatched) { console.log('HALT', sku, 'RETRIES_EXHAUSTED'); process.exit(1); }

  if (dispatched.listingId && dispatched.dispatchFailureStage) {
    console.log('HALT', sku, 'PUBLISH_REFUSED',
      JSON.stringify(dispatched.dispatchFailureEbayErrorMessages).slice(0, 250));
    process.exit(1);
  }
  let resolved = dispatched.status === 'created-and-reconciled';
  for (let attempt = 0; !resolved && dispatched.listingId
    && dispatched.jobId && dispatched.attemptId && attempt < 4; attempt += 1) {
    await sleep(10000 + attempt * 10000);
    const reconciled = await run([CLI, 'reconcile', '--action', 'create', ...target,
      '--migration-store', STORE,
      '--job-id', dispatched.jobId, '--attempt-id', dispatched.attemptId]);
    resolved = Boolean(reconciled && reconciled.resolution === 'resolved_existing');
  }
  if (!resolved) {
    console.log('HALT', sku, 'UNRESOLVED', JSON.stringify({
      listingId: dispatched.listingId ?? null,
      messages: dispatched.dispatchFailureEbayErrorMessages ?? null,
      jobId: dispatched.jobId,
      attemptId: dispatched.attemptId,
      offerId: dispatched.offerId ?? null,
    }));
    process.exit(1);
  }
  live += 1;
  console.log('LIVE', sku, dispatched.listingId);
  await sleep(60000);
}
console.log('DONE published', live, 'skipped', skipped, 'of', ready.length);
