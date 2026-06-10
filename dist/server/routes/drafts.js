/**
 * Draft/Staging Review Queue API Routes
 *
 * Provides endpoints for reviewing, approving, rejecting, and managing
 * product drafts that go through the staging system.
 */
import { Router } from 'express';
import { getDraft, getDraftByProduct, listPendingDrafts, approveDraft, rejectDraft, updateDraft, getPendingDraftCount, getAllAutoPublishSettings, setAutoPublishSetting, updateGlobalAutoPublishSettings, checkExistingContent, fetchProductTagsBatch, } from '../../services/draft-service.js';
import { listDraftOnEbay, previewEbayListing } from '../../services/ebay-draft-lister.js';
import { info, error as logError } from '../../utils/logger.js';
const router = Router();
// ── GET /api/drafts — List drafts with pagination ─────────────────────
router.get('/api/drafts', async (req, res) => {
    try {
        const status = req.query.status || 'pending';
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        const offset = parseInt(req.query.offset) || 0;
        const result = await listPendingDrafts({ status, limit, offset });
        // Enrich drafts with Shopify tags (for condition badges)
        const productIds = result.data.map((d) => d.shopify_product_id).filter(Boolean);
        const tagsMap = await fetchProductTagsBatch(productIds);
        const enrichedData = result.data.map((d) => ({
            ...d,
            tags: tagsMap[d.shopify_product_id] || [],
        }));
        res.json({
            data: enrichedData,
            total: result.total,
            limit,
            offset,
            pendingCount: await getPendingDraftCount(),
        });
    }
    catch (err) {
        logError(`[DraftsAPI] List error: ${err}`);
        res.status(500).json({ error: 'Failed to list drafts' });
    }
});
// ── GET /api/drafts/count — Get pending draft count (for badge) ───────
router.get('/api/drafts/count', async (_req, res) => {
    try {
        const count = await getPendingDraftCount();
        res.json({ count });
    }
    catch (err) {
        logError(`[DraftsAPI] Count error: ${err}`);
        res.status(500).json({ error: 'Failed to get draft count' });
    }
});
// ── GET /api/drafts/settings — Get auto-publish settings ──────────────
router.get('/api/drafts/settings', async (_req, res) => {
    try {
        const settings = await getAllAutoPublishSettings();
        res.json(settings);
    }
    catch (err) {
        logError(`[DraftsAPI] Settings read error: ${err}`);
        res.status(500).json({ error: 'Failed to get settings' });
    }
});
// ── PUT /api/drafts/settings — Update auto-publish settings ───────────
router.put('/api/drafts/settings', async (req, res) => {
    try {
        const { perType, global } = req.body;
        // Update per-type settings
        if (Array.isArray(perType)) {
            for (const item of perType) {
                if (item.product_type && typeof item.enabled === 'boolean') {
                    await setAutoPublishSetting(item.product_type, item.enabled);
                }
            }
        }
        // Update global settings
        if (global) {
            await updateGlobalAutoPublishSettings(global);
        }
        const updated = await getAllAutoPublishSettings();
        res.json(updated);
    }
    catch (err) {
        logError(`[DraftsAPI] Settings update error: ${err}`);
        res.status(500).json({ error: 'Failed to update settings' });
    }
});
// ── GET /api/drafts/product/:productId — Get pending draft for a product ───
router.get('/api/drafts/product/:productId', async (req, res) => {
    try {
        const productId = req.params.productId;
        if (!productId) {
            res.status(400).json({ error: 'Product ID required' });
            return;
        }
        const draft = await getDraftByProduct(productId);
        if (!draft) {
            res.json({ draft: null });
            return;
        }
        // Fetch current live Shopify data for comparison
        const liveContent = await checkExistingContent(draft.shopify_product_id);
        res.json({
            draft: { ...draft, tags: liveContent.tags },
            live: {
                title: liveContent.title,
                description: liveContent.description,
                images: liveContent.images,
                hasPhotos: liveContent.hasPhotos,
                hasDescription: liveContent.hasDescription,
            },
        });
    }
    catch (err) {
        logError(`[DraftsAPI] Get draft by product error: ${err}`);
        res.status(500).json({ error: 'Failed to get draft for product' });
    }
});
// ── GET /api/drafts/:id — Get single draft with comparison data ───────
router.get('/api/drafts/:id', async (req, res) => {
    try {
        const draftId = parseInt(req.params.id);
        if (isNaN(draftId)) {
            res.status(400).json({ error: 'Invalid draft ID' });
            return;
        }
        const draft = await getDraft(draftId);
        if (!draft) {
            res.status(404).json({ error: 'Draft not found' });
            return;
        }
        // Fetch current live Shopify data for side-by-side comparison
        const liveContent = await checkExistingContent(draft.shopify_product_id);
        res.json({
            draft: { ...draft, tags: liveContent.tags },
            live: {
                title: liveContent.title,
                description: liveContent.description,
                images: liveContent.images,
                hasPhotos: liveContent.hasPhotos,
                hasDescription: liveContent.hasDescription,
            },
        });
    }
    catch (err) {
        logError(`[DraftsAPI] Get draft error: ${err}`);
        res.status(500).json({ error: 'Failed to get draft' });
    }
});
// ── POST /api/drafts/:id/approve — Approve a draft ───────────────────
router.post('/api/drafts/:id/approve', async (req, res) => {
    try {
        const draftId = parseInt(req.params.id);
        if (isNaN(draftId)) {
            res.status(400).json({ error: 'Invalid draft ID' });
            return;
        }
        const { photos = true, description = true, publish } = req.body || {};
        info(`[Wizard] Approving draft ${draftId} — photos=${photos}, description=${description}, publish=${publish}`);
        const result = await approveDraft(draftId, { photos, description, publish });
        info(`[Wizard] Approve result for draft ${draftId}: ${JSON.stringify(result)}`);
        if (result.success) {
            res.json({ success: true, message: 'Draft approved and pushed to Shopify', published: result.published, publishError: result.publishError });
        }
        else {
            res.status(400).json({ success: false, error: result.error });
        }
    }
    catch (err) {
        logError(`[DraftsAPI] Approve error: ${err}`);
        res.status(500).json({ error: 'Failed to approve draft' });
    }
});
// ── POST /api/drafts/:id/reject — Reject a draft ─────────────────────
router.post('/api/drafts/:id/reject', async (req, res) => {
    try {
        const draftId = parseInt(req.params.id);
        if (isNaN(draftId)) {
            res.status(400).json({ error: 'Invalid draft ID' });
            return;
        }
        const result = await rejectDraft(draftId);
        if (result.success) {
            res.json({ success: true, message: 'Draft rejected' });
        }
        else {
            res.status(400).json({ success: false, error: result.error });
        }
    }
    catch (err) {
        logError(`[DraftsAPI] Reject error: ${err}`);
        res.status(500).json({ error: 'Failed to reject draft' });
    }
});
// ── PUT /api/drafts/:id — Edit a draft before approving ──────────────
router.put('/api/drafts/:id', async (req, res) => {
    try {
        const draftId = parseInt(req.params.id);
        if (isNaN(draftId)) {
            res.status(400).json({ error: 'Invalid draft ID' });
            return;
        }
        const { title, description, images } = req.body;
        const result = await updateDraft(draftId, { title, description, images });
        if (result.success) {
            const updated = await getDraft(draftId);
            res.json({ success: true, draft: updated });
        }
        else {
            res.status(400).json({ success: false, error: result.error });
        }
    }
    catch (err) {
        logError(`[DraftsAPI] Update error: ${err}`);
        res.status(500).json({ error: 'Failed to update draft' });
    }
});
// ── POST /api/drafts/approve-all — Bulk approve pending drafts ────────
router.post('/api/drafts/approve-all', async (req, res) => {
    try {
        const { photos = true, description = true, confirm = false } = req.body || {};
        if (!confirm) {
            // Return count for confirmation dialog
            const count = await getPendingDraftCount();
            res.json({
                requiresConfirmation: true,
                pendingCount: count,
                message: `This will approve ${count} pending drafts. Send { confirm: true } to proceed.`,
            });
            return;
        }
        const pending = await listPendingDrafts({ status: 'pending', limit: 200, offset: 0 });
        let approved = 0;
        let failed = 0;
        const errors = [];
        for (const draft of pending.data) {
            const result = await approveDraft(draft.id, { photos, description });
            if (result.success) {
                approved++;
            }
            else {
                failed++;
                errors.push(`Draft #${draft.id}: ${result.error}`);
            }
        }
        info(`[DraftsAPI] Bulk approve: ${approved} approved, ${failed} failed`);
        res.json({
            success: true,
            approved,
            failed,
            errors: errors.length > 0 ? errors : undefined,
        });
    }
    catch (err) {
        logError(`[DraftsAPI] Bulk approve error: ${err}`);
        res.status(500).json({ error: 'Failed to bulk approve drafts' });
    }
});
// ── POST /api/drafts/:id/preview-ebay-listing — Dry run ───────────────
router.post('/api/drafts/:id/preview-ebay-listing', async (req, res) => {
    try {
        const draftId = parseInt(req.params.id);
        if (isNaN(draftId)) {
            res.status(400).json({ error: 'Invalid draft ID' });
            return;
        }
        info(`[DraftsAPI] Preview eBay listing for draft ${draftId}`);
        const result = await previewEbayListing(draftId);
        if (result.success) {
            res.json({ success: true, preview: result.preview });
        }
        else {
            res.status(400).json({ success: false, error: result.error });
        }
    }
    catch (err) {
        logError(`[DraftsAPI] Preview eBay listing error: ${err}`);
        res.status(500).json({ error: 'Failed to preview eBay listing' });
    }
});
// ── POST /api/drafts/:id/list-on-ebay — Create live eBay listing ──────
router.post('/api/drafts/:id/list-on-ebay', async (req, res) => {
    try {
        const draftId = parseInt(req.params.id);
        if (isNaN(draftId)) {
            res.status(400).json({ error: 'Invalid draft ID' });
            return;
        }
        // Extract optional overrides from the request body (from the prep page)
        const { title, price, categoryId, condition, aspects, description, imageUrls } = req.body || {};
        const overrides = {};
        if (typeof title === 'string' && title.trim())
            overrides.title = title.trim();
        if (typeof price === 'number' && price > 0)
            overrides.price = price;
        if (typeof categoryId === 'string' && categoryId.trim())
            overrides.categoryId = categoryId.trim();
        if (typeof condition === 'string' && condition.trim())
            overrides.condition = condition.trim();
        if (aspects && typeof aspects === 'object')
            overrides.aspects = aspects;
        if (typeof description === 'string')
            overrides.description = description;
        if (Array.isArray(imageUrls) && imageUrls.length > 0)
            overrides.imageUrls = imageUrls;
        info(`[Wizard] List draft ${draftId} on eBay (explicit user action, overrides: ${JSON.stringify(Object.keys(overrides))})`);
        const result = await listDraftOnEbay(draftId, overrides);
        info(`[Wizard] eBay listing result for draft ${draftId}: ${JSON.stringify(result)}`);
        if (result.success) {
            res.json({
                success: true,
                listingId: result.listingId,
                offerId: result.offerId,
                sku: result.sku,
                ebayUrl: result.listingId
                    ? `https://www.ebay.com/itm/${result.listingId}`
                    : undefined,
            });
        }
        else {
            res.status(400).json({ success: false, error: result.error });
        }
    }
    catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const errStack = err instanceof Error ? err.stack : undefined;
        logError(`[Wizard] List on eBay error: ${errMsg}`);
        if (errStack)
            logError(`[Wizard] Stack: ${errStack}`);
        res.status(500).json({ error: errMsg || 'Failed to list on eBay' });
    }
});
export default router;
