/**
 * StyleShoots Folder Watcher — Phase 1
 *
 * Watches /Volumes/StyleShootsDrive/UsedCameraGear/ for new product folders.
 * When a folder stabilizes (30s no file changes), it:
 *   1. Parses the folder name for product name + serial suffix
 *   2. Searches Shopify for a matching product
 *   3. Uploads the JPEG images directly to the matched Shopify product
 *   4. Records the result in the styleshoot_watch_log table
 *
 * Folder structure:
 *   UsedCameraGear/{preset}/{productName}/photos.jpg
 *
 * Preset folders (e.g. "Trade-Ins - Small Lenses") are tracked as categories.
 */

import chokidar, { type FSWatcher } from 'chokidar';
import fs from 'node:fs';
import path from 'node:path';
import { info, warn, error as logError } from '../utils/logger.js';
import { parseFolderName, isImageFile } from './folder-parser.js';
import { FolderStabilizer } from './stabilizer.js';
import {
  initWatcherTable,
  isProcessed,
  hasRecord,
  recordDetection,
  updateMatch,
  updateUploading,
  updateDone,
  updateError,
  getWatcherStats,
  getUnmatched,
  getRecent,
} from './watcher-db.js';
import { searchShopifyProduct } from './shopify-matcher.js';

// ── Configuration ──────────────────────────────────────────────────────

const DEFAULT_WATCH_PATH = '/Volumes/StyleShootsDrive/UsedCameraGear/';
const DEFAULT_STABILIZE_MS = 30_000;   // 30 seconds
const MOUNT_CHECK_INTERVAL = 60_000;   // 1 minute
const MIN_IMAGES = 1;

// ── State ──────────────────────────────────────────────────────────────

let watcher: FSWatcher | null = null;
let stabilizer: FolderStabilizer | null = null;
let watchPath = DEFAULT_WATCH_PATH;
let isRunning = false;
let mountConnected = false;
let mountCheckTimer: ReturnType<typeof setInterval> | null = null;
let lastScanTime: number | null = null;

// Track which product folders we've already started processing
const processingFolders = new Set<string>();

// ── Public API ─────────────────────────────────────────────────────────

export interface WatcherStatus {
  running: boolean;
  watchPath: string;
  mountConnected: boolean;
  lastScanTime: number | null;
  stats: {
    total: number;
    done: number;
    unmatched: number;
    errors: number;
    pending: number;
  };
}

/**
 * Start the folder watcher.
 */
export async function startWatcher(options?: {
  watchPath?: string;
  stabilizeMs?: number;
}): Promise<void> {
  if (isRunning) {
    warn('[Watcher] Already running');
    return;
  }

  watchPath = options?.watchPath ?? DEFAULT_WATCH_PATH;
  const stabilizeMs = options?.stabilizeMs ?? DEFAULT_STABILIZE_MS;

  // Initialize DB table
  await initWatcherTable();

  // Check mount
  mountConnected = checkMount(watchPath);
  if (!mountConnected) {
    warn(`[Watcher] Watch path not available: ${watchPath}`);
    warn('[Watcher] Starting in disconnected mode — will retry when mount is available');
  }

  // Create stabilizer
  stabilizer = new FolderStabilizer({ stabilizeMs });

  // Start mount health check
  mountCheckTimer = setInterval(() => {
    const wasConnected = mountConnected;
    mountConnected = checkMount(watchPath);

    if (!wasConnected && mountConnected) {
      info('[Watcher] Mount reconnected — restarting chokidar and rescanning...');
      startChokidarWatcher(watchPath, stabilizeMs);
      scanExistingFolders().catch(err => logError(`[Watcher] Rescan error: ${err}`));
    } else if (wasConnected && !mountConnected) {
      warn('[Watcher] Mount disconnected — waiting for reconnection...');
    }
  }, MOUNT_CHECK_INTERVAL);

  // Start chokidar watcher
  if (mountConnected) {
    startChokidarWatcher(watchPath, stabilizeMs);
    // Initial scan of existing folders
    await scanExistingFolders();
  }

  isRunning = true;
  info(`[Watcher] ✅ Started — watching ${watchPath}`);
}

/**
 * Stop the folder watcher.
 */
export async function stopWatcher(): Promise<void> {
  if (!isRunning) {
    warn('[Watcher] Not running');
    return;
  }

  if (watcher) {
    await watcher.close();
    watcher = null;
  }

  if (stabilizer) {
    stabilizer.cancelAll();
    stabilizer = null;
  }

  if (mountCheckTimer) {
    clearInterval(mountCheckTimer);
    mountCheckTimer = null;
  }

  processingFolders.clear();
  isRunning = false;
  info('[Watcher] Stopped');
}

/**
 * Get the current watcher status.
 */
export async function getStatus(): Promise<WatcherStatus> {
  let stats = { total: 0, done: 0, unmatched: 0, errors: 0, pending: 0 };

  try {
    stats = await getWatcherStats();
  } catch {
    // DB not initialized yet
  }

  return {
    running: isRunning,
    watchPath,
    mountConnected,
    lastScanTime,
    stats,
  };
}

/**
 * Re-export for route access.
 */
export { getUnmatched, getRecent };

// ── Internal ───────────────────────────────────────────────────────────

/**
 * Check if the watch path is accessible (mount is connected).
 */
function checkMount(dirPath: string): boolean {
  try {
    fs.accessSync(dirPath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Start the chokidar file system watcher.
 */
function startChokidarWatcher(dirPath: string, _stabilizeMs: number): void {
  if (watcher) {
    watcher.close().catch(() => {});
  }

  watcher = chokidar.watch(dirPath, {
    persistent: true,
    ignoreInitial: true,      // Don't fire for existing files on start
    depth: 3,                  // UsedCameraGear/{preset}/{product}/photos
    awaitWriteFinish: false,   // We handle stabilization ourselves
    ignorePermissionErrors: true,
    ignored: [
      /(^|[\/\\])\../,        // Hidden files (.DS_Store, ._ files)
      /Thumbs\.db$/i,
    ],
  });

  watcher.on('add', (filePath: string) => {
    onFileEvent(filePath, 'add');
  });

  watcher.on('change', (filePath: string) => {
    onFileEvent(filePath, 'change');
  });

  watcher.on('addDir', (dirPath: string) => {
    onDirectoryAdded(dirPath);
  });

  watcher.on('error', (error: unknown) => {
    logError(`[Watcher] Chokidar error: ${error instanceof Error ? error.message : String(error)}`);
    // Don't crash — might be a transient mount issue
  });

  info('[Watcher] Chokidar watching');
}

/**
 * Handle file add/change events — used for stabilizer notifications.
 */
function onFileEvent(filePath: string, _event: string): void {
  if (!stabilizer) return;

  // Determine the product folder (2 levels up from the file)
  // Structure: UsedCameraGear/{preset}/{product}/photo.jpg
  const relative = path.relative(watchPath, filePath);
  const parts = relative.split(path.sep);

  // We need at least: preset/product/file
  if (parts.length < 3) return;

  const productFolder = path.join(watchPath, parts[0], parts[1]);

  // Notify the stabilizer of file activity
  stabilizer.notifyChange(productFolder);
}

/**
 * Handle new directory detection.
 *
 * We care about product-level directories (depth 2 from root):
 *   UsedCameraGear/{preset}/{product}/
 */
function onDirectoryAdded(dirPath: string): void {
  const relative = path.relative(watchPath, dirPath);
  const parts = relative.split(path.sep);

  // Product folders are at depth 2: {preset}/{product}
  if (parts.length !== 2) return;

  const presetName = parts[0];
  const folderName = parts[1];

  info(`[Watcher] New product folder detected: ${presetName}/${folderName}`);

  // Start stabilization + processing pipeline
  handleNewFolder(dirPath, presetName, folderName).catch(err => {
    logError(`[Watcher] Error handling folder ${folderName}: ${err}`);
  });
}

/**
 * Scan existing folders in the watch directory for any that haven't been processed.
 */
async function scanExistingFolders(): Promise<void> {
  if (!mountConnected) return;

  info('[Watcher] Scanning existing folders...');
  lastScanTime = Date.now();

  try {
    const presets = fs.readdirSync(watchPath, { withFileTypes: true });

    for (const preset of presets) {
      if (!preset.isDirectory() || preset.name.startsWith('.')) continue;

      const presetPath = path.join(watchPath, preset.name);
      let productDirs: fs.Dirent[];

      try {
        productDirs = fs.readdirSync(presetPath, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const product of productDirs) {
        if (!product.isDirectory() || product.name.startsWith('.')) continue;

        const productPath = path.join(presetPath, product.name);
        const folderName = product.name;

        // Skip already processed or currently processing
        if (processingFolders.has(productPath)) continue;

        const alreadyDone = await isProcessed(productPath);
        if (alreadyDone) continue;

        info(`[Watcher] Found unprocessed folder: ${preset.name}/${folderName}`);
        handleNewFolder(productPath, preset.name, folderName).catch(err => {
          logError(`[Watcher] Error handling folder ${folderName}: ${err}`);
        });
      }
    }

    info('[Watcher] Scan complete');
  } catch (err) {
    logError(`[Watcher] Scan error: ${err}`);
  }
}

/**
 * Full processing pipeline for a new product folder.
 */
async function handleNewFolder(
  folderPath: string,
  presetName: string,
  folderName: string,
): Promise<void> {
  // Prevent duplicate processing
  if (processingFolders.has(folderPath)) return;
  processingFolders.add(folderPath);

  try {
    // Already done?
    if (await isProcessed(folderPath)) {
      info(`[Watcher] Already processed: ${folderName}`);
      return;
    }

    // Parse folder name
    const parsed = parseFolderName(folderName);

    // Wait for stabilization (files done copying)
    if (stabilizer && !stabilizer.isPending(folderPath)) {
      info(`[Watcher] Waiting for folder to stabilize: ${folderName}`);
      try {
        await stabilizer.waitForStable(folderPath);
      } catch (err) {
        warn(`[Watcher] Stabilizer error for ${folderName}: ${err}`);
        // Continue anyway — files might be ready
      }
    }

    // Collect image files
    const imagePaths = collectImages(folderPath);
    if (imagePaths.length < MIN_IMAGES) {
      warn(`[Watcher] No images found in ${folderName} — skipping`);
      if (!(await hasRecord(folderPath))) {
        const id = await recordDetection({
          folderName,
          folderPath,
          presetName,
          productName: parsed.productName,
          serialSuffix: parsed.serialSuffix,
          imageCount: 0,
        });
        await updateError(id, 'No images found in folder');
      }
      return;
    }

    info(`[Watcher] Processing: ${folderName} (${imagePaths.length} images, preset: ${presetName})`);

    // Record in DB
    let recordId: number;
    if (await hasRecord(folderPath)) {
      // Get existing record ID
      const { getRawDb } = await import('../db/client.js');
      const db = await getRawDb();
      const row = db.prepare(`SELECT id FROM styleshoot_watch_log WHERE folder_path = ?`).get(folderPath) as { id: number };
      recordId = row.id;
    } else {
      recordId = await recordDetection({
        folderName,
        folderPath,
        presetName,
        productName: parsed.productName,
        serialSuffix: parsed.serialSuffix,
        imageCount: imagePaths.length,
      });
    }

    // Search Shopify for matching product
    info(`[Watcher] Searching Shopify for: "${parsed.productName}" ${parsed.serialSuffix ? `#${parsed.serialSuffix}` : ''}`);

    const match = await searchShopifyProduct(parsed.productName, parsed.serialSuffix);

    if (!match) {
      warn(`[Watcher] ⚠️ No Shopify match found for: ${folderName}`);
      await updateMatch(recordId, null, null, 'unmatched');
      return;
    }

    info(`[Watcher] Matched to Shopify product: ${match.title} (ID: ${match.id}, confidence: ${match.confidence})`);
    await updateMatch(recordId, match.id, match.title, match.confidence);

    // Run the unified auto-listing pipeline: it finds these photos on the
    // drive itself, processes them with the saved template (background,
    // shadow, watermark), pushes them to Shopify via the draft system, and
    // auto-publishes only when safe. Reuses an existing AI description if
    // the products/create webhook already generated one.
    await updateUploading(recordId);

    try {
      const { autoListProduct } = await import('../sync/auto-listing-pipeline.js');
      const result = await autoListProduct(match.id, {
        reuseExistingDescription: true,
        requireReview: match.confidence !== 'exact',
      });

      if (result.success) {
        await updateDone(recordId, imagePaths.length);
        info(`[Watcher] ✅ Done: ${folderName} → ${match.title} (job ${result.jobId}, ${result.images?.length ?? 0} images processed)`);
      } else {
        await updateError(recordId, result.error ?? 'auto-listing pipeline failed');
        warn(`[Watcher] Pipeline failed for ${folderName}: ${result.error}`);
      }
    } catch (pipelineErr) {
      await updateError(recordId, `Pipeline failed: ${String(pipelineErr)}`);
      logError(`[Watcher] ❌ Pipeline failed for ${folderName}: ${pipelineErr}`);
    }
  } catch (err) {
    logError(`[Watcher] Pipeline error for ${folderName}: ${err}`);
    try {
      if (await hasRecord(folderPath)) {
        const { getRawDb } = await import('../db/client.js');
        const db = await getRawDb();
        const row = db.prepare(`SELECT id FROM styleshoot_watch_log WHERE folder_path = ?`).get(folderPath) as { id: number } | undefined;
        if (row) {
          await updateError(row.id, String(err));
        }
      }
    } catch {
      // Best effort error recording
    }
  } finally {
    processingFolders.delete(folderPath);
  }
}

/**
 * Collect all image files from a product folder.
 * Sorts by filename for consistent ordering.
 */
function collectImages(folderPath: string): string[] {
  try {
    const files = fs.readdirSync(folderPath);
    return files
      .filter(isImageFile)
      .sort()
      .map(f => path.join(folderPath, f));
  } catch (err) {
    logError(`[Watcher] Error reading folder ${folderPath}: ${err}`);
    return [];
  }
}
