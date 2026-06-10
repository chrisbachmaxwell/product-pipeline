/**
 * Template API Routes — Phase 3
 *
 * CRUD endpoints for photo templates + apply/set-default actions.
 */

import { Router, type Request, type Response } from 'express';
import { info, error as logError } from '../../utils/logger.js';
import { getRawDb } from '../../db/client.js';
import { getImageService, timedImageCall } from '../../services/image-service-factory.js';
import { replaceProductImages, listProductImages, type ImageInput } from '../../shopify/images.js';
import { promises as fs } from 'fs';
import {
  createTemplate,
  getTemplate,
  listTemplates,
  updateTemplate,
  deleteTemplate,
  setDefaultForCategory,
  type PhotoRoomParams,
} from '../../services/photo-templates.js';

const router = Router();

// ── Helper: get Shopify token ──────────────────────────────────────────

async function getShopifyToken(): Promise<string | null> {
  const db = await getRawDb();
  const row = db.prepare(
    `SELECT access_token FROM auth_tokens WHERE platform = 'shopify'`,
  ).get() as any;
  return row?.access_token ?? null;
}

// ── Helper: fetch product images from Shopify ──────────────────────────

async function fetchShopifyProductImages(
  accessToken: string,
  productId: string,
): Promise<Array<{ id: number; src: string; position: number; alt: string | null }>> {
  return listProductImages(accessToken, SHOPIFY_STORE_DOMAIN, productId);
}

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN ?? 'usedcameragear.myshopify.com';

// ────────────────────────────────────────────────────────────────────────
// GET /api/templates — List all templates
// ────────────────────────────────────────────────────────────────────────

router.get('/api/templates', async (req: Request, res: Response) => {
  try {
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    const templates = await listTemplates(category);
    res.json({ ok: true, templates });
  } catch (err) {
    logError(`[Templates API] List failed: ${err}`);
    res.status(500).json({ error: 'Failed to list templates', detail: String(err) });
  }
});

// ────────────────────────────────────────────────────────────────────────
// GET /api/templates/categories — Get available StyleShoots categories
// ────────────────────────────────────────────────────────────────────────

router.get('/api/templates/categories', async (req: Request, res: Response) => {
  try {
    const categories = new Set<string>();
    let mounted = false;
    
    // Try to scan StyleShoots drive for directory names
    const styleshootsDrive = '/Volumes/StyleShootsDrive/UsedCameraGear';
    try {
      const entries = await fs.readdir(styleshootsDrive, { withFileTypes: true });
      entries
        .filter(entry => entry.isDirectory())
        .forEach(dir => categories.add(dir.name));
      mounted = true;
      info(`[Templates API] Scanned StyleShoots drive: found ${entries.filter(e => e.isDirectory()).length} folders`);
    } catch (err) {
      info(`[Templates API] StyleShoots drive not mounted or not accessible: ${err}`);
    }
    
    // Also get categories already assigned to templates in the DB
    const db = await getRawDb();
    const dbCategories = db.prepare(
      `SELECT DISTINCT category FROM photo_templates WHERE category IS NOT NULL AND category != ''`
    ).all() as Array<{ category: string }>;
    
    dbCategories.forEach(row => categories.add(row.category));
    
    const sortedCategories = Array.from(categories).sort();
    
    info(`[Templates API] Found ${sortedCategories.length} total categories (drive mounted: ${mounted})`);
    
    res.json({ 
      ok: true, 
      categories: sortedCategories, 
      mounted 
    });
  } catch (err) {
    logError(`[Templates API] Get categories failed: ${err}`);
    res.status(500).json({ error: 'Failed to get categories', detail: String(err) });
  }
});

// ────────────────────────────────────────────────────────────────────────
// GET /api/templates/:id — Get single template
// ────────────────────────────────────────────────────────────────────────

router.get('/api/templates/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid template ID' });
      return;
    }
    const template = await getTemplate(id);
    if (!template) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }
    res.json({ ok: true, template });
  } catch (err) {
    logError(`[Templates API] Get failed: ${err}`);
    res.status(500).json({ error: 'Failed to get template', detail: String(err) });
  }
});

// ────────────────────────────────────────────────────────────────────────
// POST /api/templates — Create a new template
// Body: { name, params: { background, padding, shadow }, category?, isDefault? }
// ────────────────────────────────────────────────────────────────────────

router.post('/api/templates', async (req: Request, res: Response) => {
  try {
    const { name, params, category, isDefault } = req.body;

    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    if (!params || typeof params !== 'object') {
      res.status(400).json({ error: 'params object is required (background, padding, shadow)' });
      return;
    }

    const templateParams: PhotoRoomParams = {
      background: params.background ?? '#FFFFFF',
      padding: typeof params.padding === 'number' ? params.padding : 0.1,
      shadow: typeof params.shadow === 'boolean' ? params.shadow : true,
    };

    const template = await createTemplate(name, templateParams, category ?? null, !!isDefault);
    res.status(201).json({ ok: true, template });
  } catch (err: any) {
    if (err?.message?.includes('UNIQUE constraint')) {
      res.status(409).json({ error: 'A template with that name already exists' });
      return;
    }
    logError(`[Templates API] Create failed: ${err}`);
    res.status(500).json({ error: 'Failed to create template', detail: String(err) });
  }
});

// ────────────────────────────────────────────────────────────────────────
// PUT /api/templates/:id — Update a template
// Body: { name?, params?: { background?, padding?, shadow? }, category?, isDefault? }
// ────────────────────────────────────────────────────────────────────────

router.put('/api/templates/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid template ID' });
      return;
    }

    const { name, params, category, isDefault } = req.body;

    const template = await updateTemplate(id, {
      name,
      category,
      params,
      isDefault,
    });

    if (!template) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }

    res.json({ ok: true, template });
  } catch (err: any) {
    if (err?.message?.includes('UNIQUE constraint')) {
      res.status(409).json({ error: 'A template with that name already exists' });
      return;
    }
    logError(`[Templates API] Update failed: ${err}`);
    res.status(500).json({ error: 'Failed to update template', detail: String(err) });
  }
});

// ────────────────────────────────────────────────────────────────────────
// DELETE /api/templates/:id — Delete a template
// ────────────────────────────────────────────────────────────────────────

router.delete('/api/templates/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid template ID' });
      return;
    }

    const deleted = await deleteTemplate(id);
    if (!deleted) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }

    res.json({ ok: true, deleted: true });
  } catch (err) {
    logError(`[Templates API] Delete failed: ${err}`);
    res.status(500).json({ error: 'Failed to delete template', detail: String(err) });
  }
});

// ────────────────────────────────────────────────────────────────────────
// POST /api/templates/:id/apply/:productId — Apply template to a product's photos
// ────────────────────────────────────────────────────────────────────────

router.post('/api/templates/:id/apply/:productId', async (req: Request, res: Response) => {
  try {
    const templateId = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
    const productId = Array.isArray(req.params.productId) ? req.params.productId[0] : req.params.productId;

    if (isNaN(templateId)) {
      res.status(400).json({ error: 'Invalid template ID' });
      return;
    }

    const template = await getTemplate(templateId);
    if (!template) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }

    const accessToken = await getShopifyToken();
    if (!accessToken) {
      res.status(400).json({ error: 'Shopify token not configured' });
      return;
    }

    // Fetch product images
    const shopifyImages = await fetchShopifyProductImages(accessToken, productId);
    if (shopifyImages.length === 0) {
      res.status(400).json({ error: 'Product has no images' });
      return;
    }

    info(`[Templates API] Applying template "${template.name}" to product ${productId} (${shopifyImages.length} images)`);

    const db = await getRawDb();
    const imageService = await getImageService();
    const results: Array<{
      originalUrl: string;
      processedUrl: string | null;
      status: string;
      error?: string;
    }> = [];

    // Process every image first, then replace the product's image set in one
    // pass. Failed images keep their original URL so nothing is lost.
    const replacementImages: ImageInput[] = [];
    const replacementAlts: Array<string | null> = [];

    for (const img of shopifyImages) {
      const now = Math.floor(Date.now() / 1000);
      const insertResult = db.prepare(
        `INSERT INTO image_processing_log (product_id, image_url, original_url, status, params_json, created_at, updated_at)
         VALUES (?, ?, ?, 'processing', ?, ?, ?)`,
      ).run(productId, img.src, img.src, JSON.stringify(template.params), now, now);
      const logId = insertResult.lastInsertRowid;

      try {
        const { buffer, dataUrl } = await timedImageCall(
          `template="${template.name}" product=${productId} image=${img.id}`,
          () => imageService.processWithParams(img.src, template.params),
        );

        db.prepare(
          `UPDATE image_processing_log SET status = 'completed', processed_url = ?, updated_at = ? WHERE id = ?`,
        ).run(dataUrl, Math.floor(Date.now() / 1000), logId);

        replacementImages.push({ buffer, filename: `template-${template.id}-${img.id}-${Date.now()}.png` });
        replacementAlts.push(img.alt);
        results.push({ originalUrl: img.src, processedUrl: dataUrl, status: 'completed' });
      } catch (processErr) {
        db.prepare(
          `UPDATE image_processing_log SET status = 'error', error = ?, updated_at = ? WHERE id = ?`,
        ).run(String(processErr), Math.floor(Date.now() / 1000), logId);

        replacementImages.push(img.src);
        replacementAlts.push(img.alt);
        results.push({
          originalUrl: img.src,
          processedUrl: null,
          status: 'error',
          error: String(processErr),
        });
      }
    }

    const succeeded = results.filter((r) => r.status === 'completed').length;
    const failed = results.filter((r) => r.status === 'error').length;

    // Replace the product images (delete originals, upload processed set in
    // original order) — but only if at least one image actually processed.
    if (succeeded > 0) {
      try {
        await replaceProductImages(accessToken, SHOPIFY_STORE_DOMAIN, productId, replacementImages, {
          alts: replacementAlts,
        });
      } catch (uploadErr) {
        logError(`[Templates API] Shopify image replace failed: ${uploadErr}`);
      }
    }

    res.json({
      ok: true,
      templateId: template.id,
      templateName: template.name,
      productId,
      total: shopifyImages.length,
      succeeded,
      failed,
      params: template.params,
      results,
    });
  } catch (err) {
    logError(`[Templates API] Apply failed: ${err}`);
    res.status(500).json({ error: 'Failed to apply template', detail: String(err) });
  }
});

// ────────────────────────────────────────────────────────────────────────
// POST /api/templates/:id/set-default — Set as default for its category
// Body: { category? } — override category if needed
// ────────────────────────────────────────────────────────────────────────

router.post('/api/templates/:id/set-default', async (req: Request, res: Response) => {
  try {
    const id = parseInt(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid template ID' });
      return;
    }

    const existing = await getTemplate(id);
    if (!existing) {
      res.status(404).json({ error: 'Template not found' });
      return;
    }

    const category = req.body?.category || existing.category;
    if (!category) {
      res.status(400).json({ error: 'Template has no category. Provide a category in the request body.' });
      return;
    }

    const template = await setDefaultForCategory(id, category);
    res.json({ ok: true, template });
  } catch (err) {
    logError(`[Templates API] Set default failed: ${err}`);
    res.status(500).json({ error: 'Failed to set default template', detail: String(err) });
  }
});

export default router;
