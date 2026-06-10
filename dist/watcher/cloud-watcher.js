/**
 * cloud-watcher.ts — GCS photo-arrival watcher (cloud counterpart of the
 * local StyleShoots folder watcher).
 *
 * Photos usually land in GCS (via the Mac sync-agent) AFTER the Shopify
 * product was created, so the products/create webhook ran before photos
 * existed. This poller closes that gap: it scans the bucket on an interval,
 * waits for a folder to stabilize (image count unchanged between two polls),
 * matches it to a Shopify product, and re-runs the auto-listing pipeline —
 * which processes the photos with the saved template and pushes them to
 * Shopify, reusing the AI description that was already generated.
 *
 * Dedup is handled by the existing styleshoot_watch_log table, keyed on the
 * gs:// folder path. Toggle at runtime via the `cloud_watcher_enabled`
 * settings key; interval via CLOUD_WATCH_INTERVAL_MS (default 2 min).
 */
import { info, warn, error as logError } from '../utils/logger.js';
import { getRawDb } from '../db/client.js';
import { parseFolderName } from './folder-parser.js';
import { searchShopifyProduct } from './shopify-matcher.js';
import { initWatcherTable, isProcessed, hasRecord, recordDetection, updateMatch, updateUploading, updateDone, updateError, } from './watcher-db.js';
import { isCloudMode, listGcsFolders, listGcsImages, GCS_BUCKET, } from './drive-search.js';
const POLL_INTERVAL_MS = parseInt(process.env.CLOUD_WATCH_INTERVAL_MS || '120000', 10);
// folder prefix → image count seen on the previous poll (stability check)
const lastSeenCounts = new Map();
// folders currently mid-pipeline — don't re-trigger
const processing = new Set();
let pollTimer = null;
let lastPollAt = null;
let lastPollError = null;
function gcsFolderPath(folder) {
    return `gs://${GCS_BUCKET}/${folder.prefix}`;
}
/**
 * Decide whether a folder is stable enough to process: we must have seen it
 * on a previous poll with the same image count. Exported for testing.
 */
export function isFolderStable(previousCount, currentCount) {
    return previousCount !== undefined && previousCount === currentCount && currentCount > 0;
}
export function getCloudWatcherStatus() {
    return {
        running: pollTimer !== null,
        pollIntervalMs: POLL_INTERVAL_MS,
        lastPollAt,
        lastPollError,
        pendingStabilization: lastSeenCounts.size,
    };
}
/**
 * Start the cloud watcher. No-op unless DRIVE_MODE=cloud.
 * The `cloud_watcher_enabled` setting is checked on every poll so it can be
 * toggled without a restart.
 */
export async function startCloudWatcher() {
    if (!isCloudMode()) {
        info('[CloudWatcher] DRIVE_MODE is not "cloud" — cloud watcher not started');
        return;
    }
    if (pollTimer) {
        warn('[CloudWatcher] Already running');
        return;
    }
    await initWatcherTable();
    pollTimer = setInterval(() => {
        pollOnce().catch((err) => {
            lastPollError = String(err);
            logError(`[CloudWatcher] Poll error: ${err}`);
        });
    }, POLL_INTERVAL_MS);
    info(`[CloudWatcher] ✅ Started — polling gs://${GCS_BUCKET} every ${Math.round(POLL_INTERVAL_MS / 1000)}s`);
    // Kick off an initial poll so existing unprocessed folders are picked up
    // promptly (it still needs a second poll to confirm stability).
    pollOnce().catch((err) => {
        lastPollError = String(err);
        logError(`[CloudWatcher] Initial poll error: ${err}`);
    });
}
export function stopCloudWatcher() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
        info('[CloudWatcher] Stopped');
    }
}
/**
 * Single poll cycle. Exported so a webhook/manual trigger can force a scan.
 */
export async function pollOnce() {
    const db = await getRawDb();
    const setting = db
        .prepare(`SELECT value FROM settings WHERE key = 'cloud_watcher_enabled'`)
        .get();
    if (setting && setting.value !== 'true') {
        return; // disabled — skip silently
    }
    lastPollAt = Date.now();
    lastPollError = null;
    const folders = await listGcsFolders();
    for (const folder of folders) {
        const folderPath = gcsFolderPath(folder);
        if (processing.has(folderPath))
            continue;
        if (await isProcessed(folderPath)) {
            lastSeenCounts.delete(folder.prefix);
            continue;
        }
        let imageKeys;
        try {
            imageKeys = await listGcsImages(folder.prefix);
        }
        catch (err) {
            warn(`[CloudWatcher] Failed to list images for ${folder.prefix}: ${err}`);
            continue;
        }
        const previous = lastSeenCounts.get(folder.prefix);
        if (!isFolderStable(previous, imageKeys.length)) {
            lastSeenCounts.set(folder.prefix, imageKeys.length);
            if (imageKeys.length > 0 && previous === undefined) {
                info(`[CloudWatcher] New folder detected: ${folder.presetName}/${folder.folderName} (${imageKeys.length} images) — waiting one poll for stability`);
            }
            continue;
        }
        lastSeenCounts.delete(folder.prefix);
        processing.add(folderPath);
        processFolder(folder, folderPath, imageKeys.length)
            .catch((err) => logError(`[CloudWatcher] Error processing ${folder.folderName}: ${err}`))
            .finally(() => processing.delete(folderPath));
    }
}
/**
 * Match a stable folder to a Shopify product and run the auto-listing
 * pipeline (template processing + Shopify upload + draft/auto-publish).
 */
async function processFolder(folder, folderPath, imageCount) {
    const parsed = parseFolderName(folder.folderName);
    let recordId;
    if (await hasRecord(folderPath)) {
        const db = await getRawDb();
        const row = db
            .prepare(`SELECT id FROM styleshoot_watch_log WHERE folder_path = ?`)
            .get(folderPath);
        recordId = row.id;
    }
    else {
        recordId = await recordDetection({
            folderName: folder.folderName,
            folderPath,
            presetName: folder.presetName,
            productName: parsed.productName,
            serialSuffix: parsed.serialSuffix,
            imageCount,
        });
    }
    info(`[CloudWatcher] Processing: ${folder.presetName}/${folder.folderName} (${imageCount} images)`);
    let match;
    try {
        match = await searchShopifyProduct(parsed.productName, parsed.serialSuffix, { includeDrafts: true });
    }
    catch (err) {
        await updateError(recordId, `Shopify match failed: ${err}`);
        return;
    }
    if (!match) {
        warn(`[CloudWatcher] ⚠️ No Shopify match for: ${folder.folderName}`);
        await updateMatch(recordId, null, null, 'unmatched');
        return;
    }
    info(`[CloudWatcher] Matched "${folder.folderName}" → ${match.title} (${match.id}, ${match.confidence})`);
    await updateMatch(recordId, match.id, match.title, match.confidence);
    await updateUploading(recordId);
    try {
        const { autoListProduct } = await import('../sync/auto-listing-pipeline.js');
        const result = await autoListProduct(match.id, {
            // Description was already generated by the products/create webhook in
            // the normal flow — don't regenerate it just because photos arrived.
            reuseExistingDescription: true,
            // Fuzzy matches must always be human-reviewed before anything publishes.
            requireReview: match.confidence !== 'exact',
        });
        if (result.success) {
            await updateDone(recordId, imageCount);
            info(`[CloudWatcher] ✅ Done: ${folder.folderName} → ${match.title} (job ${result.jobId}, ${result.images?.length ?? 0} images processed)`);
        }
        else {
            await updateError(recordId, result.error ?? 'auto-listing pipeline failed');
            warn(`[CloudWatcher] Pipeline failed for ${folder.folderName}: ${result.error}`);
        }
    }
    catch (err) {
        await updateError(recordId, String(err));
        logError(`[CloudWatcher] Pipeline error for ${folder.folderName}: ${err}`);
    }
}
