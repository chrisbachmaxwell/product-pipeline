/**
 * Watcher API routes — control and monitor the StyleShoots folder watcher.
 *
 * POST /api/watcher/start     — Start the watcher
 * POST /api/watcher/stop      — Stop the watcher
 * GET  /api/watcher/status    — Watcher status + stats
 * GET  /api/watcher/unmatched — Folders that couldn't be matched to Shopify products
 * GET  /api/watcher/recent    — Recent watcher log entries
 * POST /api/watcher/link      — Manually link an unmatched folder to a Shopify product
 */

import { Router, type Request, type Response } from 'express';
import {
  startWatcher,
  stopWatcher,
  getStatus,
  getUnmatched,
  getRecent,
} from '../../watcher/index.js';
import { manualLink } from '../../watcher/watcher-db.js';
import { info, error as logError } from '../../utils/logger.js';

const router = Router();

/** POST /api/watcher/start — Start the folder watcher */
router.post('/api/watcher/start', async (req: Request, res: Response) => {
  try {
    const { watchPath, stabilizeMs } = req.body || {};
    await startWatcher({ watchPath, stabilizeMs });
    const status = await getStatus();
    res.json({ success: true, status });
    info('[WatcherAPI] Watcher started');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`[WatcherAPI] Start error: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/** POST /api/watcher/stop — Stop the folder watcher */
router.post('/api/watcher/stop', async (_req: Request, res: Response) => {
  try {
    await stopWatcher();
    const status = await getStatus();
    res.json({ success: true, status });
    info('[WatcherAPI] Watcher stopped');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`[WatcherAPI] Stop error: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/** GET /api/watcher/status — Current watcher status + stats */
router.get('/api/watcher/status', async (_req: Request, res: Response) => {
  try {
    const status = await getStatus();
    res.json(status);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/** GET /api/watcher/unmatched — Folders that couldn't match a Shopify product */
router.get('/api/watcher/unmatched', async (_req: Request, res: Response) => {
  try {
    const unmatched = await getUnmatched();
    res.json({ unmatched });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/** GET /api/watcher/recent — Recent watcher log entries */
router.get('/api/watcher/recent', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const entries = await getRecent(limit);
    res.json({ entries });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/** POST /api/watcher/link — Manually link an unmatched folder to a Shopify product */
router.post('/api/watcher/link', async (req: Request, res: Response) => {
  try {
    const { id, shopifyProductId, shopifyProductTitle } = req.body;

    if (!id || !shopifyProductId) {
      res.status(400).json({ error: 'Missing required fields: id, shopifyProductId' });
      return;
    }

    await manualLink(id, shopifyProductId, shopifyProductTitle || 'Unknown');
    res.json({ success: true });
    info(`[WatcherAPI] Manually linked watch log #${id} → Shopify ${shopifyProductId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`[WatcherAPI] Link error: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

/** GET /api/watcher/cloud/status — GCS photo-arrival watcher status */
router.get('/api/watcher/cloud/status', async (_req: Request, res: Response) => {
  try {
    const { getCloudWatcherStatus } = await import('../../watcher/cloud-watcher.js');
    res.json({ ok: true, ...getCloudWatcherStatus() });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/** POST /api/watcher/cloud/poll — force an immediate GCS scan */
router.post('/api/watcher/cloud/poll', async (_req: Request, res: Response) => {
  try {
    const { pollOnce, getCloudWatcherStatus } = await import('../../watcher/cloud-watcher.js');
    await pollOnce();
    res.json({ ok: true, ...getCloudWatcherStatus() });
    info('[WatcherAPI] Manual cloud poll triggered');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`[WatcherAPI] Cloud poll error: ${msg}`);
    res.status(500).json({ error: msg });
  }
});

export default router;
