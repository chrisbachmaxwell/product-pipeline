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
/**
 * Decide whether a folder is stable enough to process: we must have seen it
 * on a previous poll with the same image count. Exported for testing.
 */
export declare function isFolderStable(previousCount: number | undefined, currentCount: number): boolean;
export interface CloudWatcherStatus {
    running: boolean;
    pollIntervalMs: number;
    lastPollAt: number | null;
    lastPollError: string | null;
    pendingStabilization: number;
}
export declare function getCloudWatcherStatus(): CloudWatcherStatus;
/**
 * Start the cloud watcher. No-op unless DRIVE_MODE=cloud.
 * The `cloud_watcher_enabled` setting is checked on every poll so it can be
 * toggled without a restart.
 */
export declare function startCloudWatcher(): Promise<void>;
export declare function stopCloudWatcher(): void;
/**
 * Single poll cycle. Exported so a webhook/manual trigger can force a scan.
 */
export declare function pollOnce(): Promise<void>;
