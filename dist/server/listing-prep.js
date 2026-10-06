/**
 * Listing prep runner — prepares every not-yet-listed product for eBay as
 * soon as it appears, instead of on publish day (operator ask 2026-10-06).
 *
 * For each ready-to-list row it runs the aspect autofill (listing-autofill.ts):
 * Claude fills the eBay item specifics no rule can derive, validated against
 * eBay's taxonomy, saved as a LOCAL draft. Whatever still needs a person is
 * listed per item so an employee sees the gaps days before publish.
 *
 * ZERO provider writes: no ceremony runs here, and only local draft saves
 * happen (the same store write the listing editor's Save performs).
 *
 * Triggers: a Shopify products/create|update webhook (debounced), plus an
 * hourly backstop. LISTING_PREP_INTERVAL_MINUTES overrides the interval;
 * "off" disables both triggers.
 */
import { info, warn } from '../utils/logger.js';
import { autofillListingAspects, createClaudeAspectProposer, } from './listing-autofill.js';
import { isPublishLockHeld } from './publish-all.js';
const DEFAULT_INTERVAL_MINUTES = 60;
const WEBHOOK_DEBOUNCE_MS = 3 * 60_000;
const MAX_ITEMS_PER_RUN = 40;
const ITEM_SPACING_MS = 10_000;
const items = new Map();
let running = false;
let lastRunAtUtc = null;
let aiArmed = false;
export function getListingPrepStatus() {
    return Object.freeze({
        state: running ? 'running' : 'idle',
        lastRunAtUtc,
        aiArmed,
        items: Object.freeze([...items.values()].sort((left, right) => Number(right.state === 'needs_input') - Number(left.state === 'needs_input')
            || left.sku.localeCompare(right.sku))),
    });
}
/** Test hook. */
export function resetListingPrepState() {
    items.clear();
    running = false;
    lastRunAtUtc = null;
    aiArmed = false;
}
const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
/**
 * One prep pass over the ready queue. Resolves false when skipped (already
 * running, or a publish run is in flight — publishing owns the drafts then).
 */
export async function runListingPrep(dependencies = {}) {
    const publishBusy = dependencies.publishBusy ?? isPublishLockHeld;
    if (running || publishBusy())
        return false;
    running = true;
    const sleep = dependencies.sleep ?? defaultSleep;
    const now = dependencies.now ?? (() => new Date().toISOString());
    try {
        const getSnapshot = dependencies.getSnapshot
            ?? (async () => (await import('./live-listing-catalog-source.js'))
                .getLiveListingCatalogSnapshot.refreshIfStale(60_000));
        const draftService = dependencies.draftService
            ?? (await import('./listing-draft-service.js'))
                .createListingDraftService();
        const getCategoryAspects = dependencies.getCategoryAspects
            ?? (async (categoryId) => (await import('./ebay-category-aspects.js'))
                .getEbayCategoryAspects(categoryId));
        const propose = await (dependencies.createProposer ?? (() => createClaudeAspectProposer()))();
        aiArmed = propose !== null;
        const snapshot = await getSnapshot();
        const ready = snapshot.rows.filter((row) => row.readyToList === true && row.shopify !== null
            && !row.shopify.sku.startsWith('PIPELINE-TEST'));
        // Rows that left the queue (published, sold, archived) drop out.
        const readyIds = new Set(ready.map((row) => row.id));
        for (const id of [...items.keys()])
            if (!readyIds.has(id))
                items.delete(id);
        // Unchecked rows first, so a new product is prepared on the next pass.
        const ordered = [...ready].sort((left, right) => Number(items.has(left.id)) - Number(items.has(right.id)));
        let processed = 0;
        for (const row of ordered.slice(0, MAX_ITEMS_PER_RUN)) {
            if (publishBusy())
                break;
            const base = { catalogId: row.id, sku: row.shopify.sku, title: row.shopify.title, checkedAtUtc: now() };
            if (row.readyToListGaps?.includes('condition')) {
                items.set(row.id, { ...base, state: 'needs_input', filled: [], missing: ['Condition'] });
                continue;
            }
            try {
                const result = await autofillListingAspects(row.id, {
                    draftService, getCategoryAspects, propose,
                }, { actor: 'listing-prep' });
                const previous = items.get(row.id);
                // `filled` accumulates so the employee sees what Claude set.
                const filled = [...new Set([...(previous?.filled ?? []), ...result.filled])];
                items.set(row.id, {
                    ...base,
                    state: result.status === 'unavailable' ? 'unavailable'
                        : result.stillMissing.length > 0 ? 'needs_input' : 'ready',
                    filled,
                    missing: result.stillMissing,
                });
            }
            catch (error) {
                items.set(row.id, { ...base, state: 'error', filled: [], missing: [] });
                warn(`[Listing Prep] ${row.shopify.sku}: ${error instanceof Error ? error.message.slice(0, 120) : 'failed'}`);
            }
            processed += 1;
            // Each draft read captures from Shopify; pace like the publisher (L63).
            await sleep(ITEM_SPACING_MS);
        }
        const needsInput = [...items.values()].filter((item) => item.state === 'needs_input').length;
        info(`[Listing Prep] checked ${processed} of ${ready.length} ready; ${needsInput} need a person`);
        return true;
    }
    finally {
        lastRunAtUtc = now();
        running = false;
    }
}
function configuredIntervalMinutes() {
    const raw = process.env.LISTING_PREP_INTERVAL_MINUTES?.trim();
    if (raw === undefined || raw === '')
        return DEFAULT_INTERVAL_MINUTES;
    if (raw.toLowerCase() === 'off')
        return null;
    const minutes = Number(raw);
    if (!Number.isSafeInteger(minutes) || minutes < 15 || minutes > 10_080) {
        warn('[Listing Prep] LISTING_PREP_INTERVAL_MINUTES invalid; using the default');
        return DEFAULT_INTERVAL_MINUTES;
    }
    return minutes;
}
let webhookTimer = null;
/** A product was created or edited: prepare it within a few minutes. */
export function notifyProductChanged(dependencies = {}) {
    if (configuredIntervalMinutes() === null)
        return false;
    if (webhookTimer)
        clearTimeout(webhookTimer);
    webhookTimer = setTimeout(() => {
        webhookTimer = null;
        void runListingPrep(dependencies).catch((error) => {
            warn(`[Listing Prep] run failed: ${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}`);
        });
    }, WEBHOOK_DEBOUNCE_MS);
    webhookTimer.unref?.();
    return true;
}
export function initListingPrepSchedule(dependencies = {}) {
    const minutes = configuredIntervalMinutes();
    if (minutes === null) {
        info('[Listing Prep] disabled (LISTING_PREP_INTERVAL_MINUTES=off)');
        return null;
    }
    info(`[Listing Prep] preparing new products every ${minutes} minutes and on product webhooks`);
    const tick = () => {
        void runListingPrep(dependencies).catch((error) => {
            warn(`[Listing Prep] run failed: ${error instanceof Error ? error.message.slice(0, 120) : 'unknown'}`);
        });
    };
    const timer = setInterval(tick, minutes * 60_000);
    timer.unref?.();
    // First pass shortly after boot, once the catalog refresher has data.
    setTimeout(tick, 5 * 60_000).unref?.();
    return timer;
}
