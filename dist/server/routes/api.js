import { Router } from 'express';
import { getRawDb } from '../../db/client.js';
import { getValidEbayToken } from '../../ebay/token-manager.js';
import { info, error as logError } from '../../utils/logger.js';
import { fetchAllShopifyProductsOverview, fetchDetailedShopifyProduct } from '../../shopify/products.js';
import { GRADE_DESCRIPTIONS } from '../../config/condition-descriptions.js';
import { CATEGORY_RULES } from '../../sync/category-mapper.js';
const router = Router();
/** GET /api/image-proxy — Proxy external images to avoid CORS issues (for canvas editing) */
router.get('/api/image-proxy', async (req, res) => {
    try {
        const url = req.query.url;
        if (!url)
            return res.status(400).json({ error: 'url param required' });
        // Only allow GCS and Shopify CDN URLs
        const allowed = ['storage.googleapis.com', 'cdn.shopify.com'];
        const parsed = new URL(url);
        if (!allowed.some(h => parsed.hostname.endsWith(h))) {
            return res.status(403).json({ error: 'URL not allowed' });
        }
        const response = await fetch(url);
        if (!response.ok)
            return res.status(response.status).send('Upstream error');
        const contentType = response.headers.get('content-type') || 'image/png';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        const buffer = Buffer.from(await response.arrayBuffer());
        res.send(buffer);
    }
    catch (err) {
        res.status(500).json({ error: 'Proxy failed' });
    }
});
/** GET /api/status — Sync status overview */
router.get('/api/status', async (_req, res) => {
    try {
        const db = await getRawDb();
        const productCount = db.prepare(`SELECT COUNT(*) as count FROM product_mappings`).get();
        const orderCount = db.prepare(`SELECT COUNT(*) as count FROM order_mappings`).get();
        const lastSyncs = db.prepare(`SELECT * FROM sync_log ORDER BY id DESC LIMIT 5`).all();
        const recentNotifications = db.prepare(`SELECT * FROM notification_log ORDER BY id DESC LIMIT 10`).all();
        const settings = db.prepare(`SELECT * FROM settings`).all();
        // Check auth token status
        const shopifyToken = db.prepare(`SELECT access_token FROM auth_tokens WHERE platform = 'shopify'`).get();
        const ebayToken = db.prepare(`SELECT access_token, expires_at FROM auth_tokens WHERE platform = 'ebay'`).get();
        res.json({
            status: 'running',
            products: { mapped: productCount?.count ?? 0 },
            orders: { imported: orderCount?.count ?? 0 },
            shopifyConnected: !!shopifyToken?.access_token,
            ebayConnected: !!ebayToken?.access_token,
            lastSyncs,
            recentNotifications,
            settings: Object.fromEntries(settings.map((s) => [s.key, s.value])),
            uptime: process.uptime(),
        });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to fetch status', detail: String(err) });
    }
});
/** GET /api/listings — Paginated product listings with eBay status, filtering & search */
router.get('/api/listings', async (req, res) => {
    try {
        const db = await getRawDb();
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        const offset = parseInt(req.query.offset) || 0;
        const search = (req.query.search || '').trim();
        const statusParam = (req.query.status || '').trim();
        const conditions = [];
        const params = [];
        // Status filter: accept comma-separated values → WHERE status IN (...)
        if (statusParam) {
            const statuses = statusParam.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
            if (statuses.length > 0) {
                conditions.push(`status IN (${statuses.map(() => '?').join(',')})`);
                params.push(...statuses);
            }
        }
        // Search filter: match against title, SKU, shopify product ID, or eBay listing ID
        if (search) {
            conditions.push(`(shopify_title LIKE ? OR shopify_sku LIKE ? OR shopify_product_id LIKE ? OR ebay_listing_id LIKE ?)`);
            const like = `%${search}%`;
            params.push(like, like, like, like);
        }
        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const countRow = db.prepare(`SELECT COUNT(*) as count FROM product_mappings ${whereClause}`).get(...params);
        const listings = db.prepare(`SELECT * FROM product_mappings ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
        res.json({ data: listings, total: countRow?.count ?? 0, limit, offset });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to fetch listings', detail: String(err) });
    }
});
/** GET /api/products/overview — Unified Shopify + pipeline + eBay status */
router.get('/api/products/overview', async (req, res) => {
    try {
        const db = await getRawDb();
        const tokenRow = db.prepare(`SELECT access_token FROM auth_tokens WHERE platform = 'shopify'`).get();
        if (!tokenRow?.access_token) {
            res.status(400).json({ error: 'Shopify token not found. Complete OAuth first.' });
            return;
        }
        const productId = req.query.productId?.trim();
        let shopifyProducts = [];
        if (productId) {
            const detailed = await fetchDetailedShopifyProduct(tokenRow.access_token, productId);
            if (!detailed) {
                res.status(404).json({ error: 'Product not found in Shopify' });
                return;
            }
            shopifyProducts = [
                {
                    id: detailed.id,
                    title: detailed.title,
                    status: detailed.status,
                    images: detailed.images.map((img) => ({ id: img.id, src: img.url, alt: img.altText })),
                    variants: detailed.variants.map((variant) => ({
                        id: variant.id,
                        sku: variant.sku,
                        price: variant.price,
                    })),
                },
            ];
        }
        else {
            shopifyProducts = await fetchAllShopifyProductsOverview(tokenRow.access_token, { includeDrafts: true });
        }
        const mappingRows = productId
            ? db.prepare(`SELECT shopify_product_id, ebay_listing_id, status FROM product_mappings WHERE shopify_product_id = ?`).all(productId)
            : db.prepare(`SELECT shopify_product_id, ebay_listing_id, status FROM product_mappings`).all();
        const pipelineRows = productId
            ? db.prepare(`SELECT * FROM product_pipeline_status WHERE shopify_product_id = ?`).all(productId)
            : db.prepare(`SELECT * FROM product_pipeline_status`).all();
        const pipelineJobRows = productId
            ? db.prepare(`SELECT id, shopify_product_id, updated_at FROM pipeline_jobs WHERE shopify_product_id = ?`).all(productId)
            : db.prepare(`SELECT id, shopify_product_id, updated_at FROM pipeline_jobs`).all();
        const mappingById = new Map();
        for (const row of mappingRows) {
            mappingById.set(String(row.shopify_product_id), row);
        }
        const pipelineById = new Map();
        for (const row of pipelineRows) {
            pipelineById.set(String(row.shopify_product_id), row);
        }
        const latestJobById = new Map();
        for (const row of pipelineJobRows) {
            const key = String(row.shopify_product_id);
            const prev = latestJobById.get(key);
            if (!prev || (row.updated_at ?? 0) > prev.updated_at) {
                latestJobById.set(key, { id: row.id, updated_at: row.updated_at ?? 0 });
            }
        }
        // Deduplicate products by ID (Shopify pagination can return duplicates)
        const seenIds = new Set();
        const uniqueProducts = shopifyProducts.filter((product) => {
            const id = String(product.id);
            if (seenIds.has(id))
                return false;
            seenIds.add(id);
            return true;
        });
        const products = uniqueProducts.map((product) => {
            const variant = product.variants?.[0];
            const mapping = mappingById.get(product.id);
            const pipeline = pipelineById.get(product.id);
            const ebayListingId = mapping?.ebay_listing_id ?? null;
            const ebayStatus = ebayListingId
                ? ebayListingId.startsWith('draft-')
                    ? 'draft'
                    : 'listed'
                : 'not_listed';
            return {
                shopifyProductId: product.id,
                title: product.title,
                sku: variant?.sku ?? '',
                price: variant?.price ?? '',
                shopifyStatus: product.status,
                imageUrl: product.images?.[0]?.src ?? null,
                imageCount: product.images?.length ?? 0,
                hasAiDescription: Boolean(pipeline?.ai_description_generated),
                hasProcessedImages: Boolean(pipeline?.images_processed),
                ebayStatus,
                ebayListingId,
                pipelineJobId: latestJobById.get(product.id)?.id ?? null,
            };
        });
        const summary = {
            total: products.length,
            withDescriptions: products.filter((p) => p.hasAiDescription).length,
            withProcessedImages: products.filter((p) => p.hasProcessedImages).length,
            listedOnEbay: products.filter((p) => p.ebayStatus === 'listed').length,
            draftOnEbay: products.filter((p) => p.ebayStatus === 'draft').length,
        };
        res.json({ products, summary });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to fetch product overview', detail: String(err) });
    }
});
/** GET /api/products/:productId/pipeline-status — Single product pipeline status */
router.get('/api/products/:productId/pipeline-status', async (req, res) => {
    try {
        const db = await getRawDb();
        const productId = Array.isArray(req.params.productId) ? req.params.productId[0] : req.params.productId;
        const row = db
            .prepare(`SELECT * FROM product_pipeline_status WHERE shopify_product_id = ?`)
            .get(productId);
        res.json({ ok: true, status: row ?? null });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to fetch pipeline status', detail: String(err) });
    }
});
/** POST /api/products/:productId/apply-ai-description — Push the stored AI description to the Shopify product */
router.post('/api/products/:productId/apply-ai-description', async (req, res) => {
    try {
        const db = await getRawDb();
        const productId = Array.isArray(req.params.productId) ? req.params.productId[0] : req.params.productId;
        const row = db
            .prepare(`SELECT ai_description FROM product_pipeline_status WHERE shopify_product_id = ?`)
            .get(productId);
        if (!row?.ai_description) {
            res.status(404).json({ error: 'No AI description stored for this product — run the pipeline first' });
            return;
        }
        const tokenRow = db
            .prepare(`SELECT access_token FROM auth_tokens WHERE platform = 'shopify'`)
            .get();
        if (!tokenRow?.access_token) {
            res.status(400).json({ error: 'Shopify token not configured' });
            return;
        }
        const { markdownToHtml } = await import('../../services/draft-service.js');
        const { loadShopifyCredentials } = await import('../../config/credentials.js');
        const creds = await loadShopifyCredentials();
        const response = await fetch(`https://${creds.storeDomain}/admin/api/2024-01/products/${productId}.json`, {
            method: 'PUT',
            headers: {
                'X-Shopify-Access-Token': tokenRow.access_token,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                product: { id: productId, body_html: markdownToHtml(row.ai_description) },
            }),
        });
        if (!response.ok) {
            const errText = await response.text();
            logError(`[API] apply-ai-description failed for ${productId}: ${response.status} — ${errText}`);
            res.status(500).json({ error: `Shopify update failed (${response.status})`, detail: errText });
            return;
        }
        info(`[API] ✅ Applied AI description to Shopify product ${productId}`);
        res.json({ ok: true, productId });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to apply AI description', detail: String(err) });
    }
});
/** GET /api/orders — Recent imported orders */
router.get('/api/orders', async (req, res) => {
    try {
        const db = await getRawDb();
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        const offset = parseInt(req.query.offset) || 0;
        const search = (req.query.search || '').trim();
        const status = (req.query.status || '').trim();
        const startDate = (req.query.startDate || '').trim();
        const endDate = (req.query.endDate || '').trim();
        const conditions = [];
        const params = [];
        if (status) {
            conditions.push('om.status = ?');
            params.push(status);
        }
        if (search) {
            const like = `%${search}%`;
            conditions.push(`(om.ebay_order_id LIKE ? OR om.shopify_order_id LIKE ? OR om.shopify_order_name LIKE ? OR eo.buyer_username LIKE ?)`);
            params.push(like, like, like, like);
        }
        if (startDate) {
            conditions.push('om.created_at >= unixepoch(?)');
            params.push(startDate);
        }
        if (endDate) {
            conditions.push('om.created_at <= unixepoch(?)');
            params.push(endDate);
        }
        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const countRow = db
            .prepare(`SELECT COUNT(*) as count
         FROM order_mappings om
         LEFT JOIN ebay_orders eo ON eo.ebay_order_id = om.ebay_order_id
         ${whereClause}`)
            .get(...params);
        const orders = db
            .prepare(`SELECT
           om.*,
           eo.total_amount as total,
           eo.currency as currency,
           eo.ebay_created_at as ebay_created_at,
           eo.buyer_username as buyer_username
         FROM order_mappings om
         LEFT JOIN ebay_orders eo ON eo.ebay_order_id = om.ebay_order_id
         ${whereClause}
         ORDER BY om.id DESC
         LIMIT ? OFFSET ?`)
            .all(...params, limit, offset);
        res.json({ data: orders, total: countRow?.count ?? 0, limit, offset });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to fetch orders', detail: String(err) });
    }
});
/** GET /api/logs — Sync and notification logs */
router.get('/api/logs', async (req, res) => {
    try {
        const db = await getRawDb();
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const source = req.query.source;
        let logs;
        if (source) {
            logs = db.prepare(`SELECT * FROM notification_log WHERE source = ? ORDER BY id DESC LIMIT ?`).all(source, limit);
        }
        else {
            logs = db.prepare(`SELECT * FROM notification_log ORDER BY id DESC LIMIT ?`).all(limit);
        }
        res.json({ data: logs });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to fetch logs', detail: String(err) });
    }
});
/** GET /api/settings — Current settings */
router.get('/api/settings', async (_req, res) => {
    try {
        const db = await getRawDb();
        const settings = db.prepare(`SELECT * FROM settings`).all();
        const result = Object.fromEntries(settings.map((s) => [s.key, s.value]));
        // Expose env-var-based config as read-only settings flags
        result.photoroom_api_key_configured = process.env.PHOTOROOM_API_KEY ? 'true' : 'false';
        result.openai_api_key_configured = process.env.OPENAI_API_KEY ? 'true' : 'false';
        res.json(result);
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to fetch settings', detail: String(err) });
    }
});
/** PUT /api/settings — Update settings */
router.put('/api/settings', async (req, res) => {
    try {
        const db = await getRawDb();
        const updates = req.body;
        const stmt = db.prepare(`INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`);
        for (const [key, value] of Object.entries(updates)) {
            stmt.run(key, String(value));
        }
        info(`[API] Settings updated: ${Object.keys(updates).join(', ')}`);
        res.json({ ok: true });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to update settings', detail: String(err) });
    }
});
/** GET /api/settings/condition-descriptions — Get condition grade descriptions (DB or defaults) */
router.get('/api/settings/condition-descriptions', async (_req, res) => {
    try {
        const db = await getRawDb();
        const row = db.prepare(`SELECT value FROM settings WHERE key = 'condition_descriptions'`).get();
        if (row?.value) {
            try {
                res.json(JSON.parse(row.value));
                return;
            }
            catch {
                // fall through to defaults
            }
        }
        res.json(GRADE_DESCRIPTIONS);
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to fetch condition descriptions', detail: String(err) });
    }
});
/** PUT /api/settings/condition-descriptions — Save condition grade descriptions to DB */
router.put('/api/settings/condition-descriptions', async (req, res) => {
    try {
        const db = await getRawDb();
        const descriptions = req.body;
        if (typeof descriptions !== 'object' || Array.isArray(descriptions)) {
            res.status(400).json({ error: 'Expected an object of grade → description' });
            return;
        }
        db.prepare(`INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`).run('condition_descriptions', JSON.stringify(descriptions));
        info('[API] Condition descriptions updated');
        res.json({ ok: true });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to save condition descriptions', detail: String(err) });
    }
});
/** GET /api/settings/ebay-categories — Get eBay category rules (DB or defaults) */
router.get('/api/settings/ebay-categories', async (_req, res) => {
    try {
        const db = await getRawDb();
        const row = db.prepare(`SELECT value FROM settings WHERE key = 'ebay_category_rules'`).get();
        if (row?.value) {
            try {
                res.json(JSON.parse(row.value));
                return;
            }
            catch {
                // fall through to defaults
            }
        }
        res.json(CATEGORY_RULES);
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to fetch eBay categories', detail: String(err) });
    }
});
/** PUT /api/settings/ebay-categories — Save eBay category rules to DB */
router.put('/api/settings/ebay-categories', async (req, res) => {
    try {
        const db = await getRawDb();
        const rules = req.body;
        if (!Array.isArray(rules)) {
            res.status(400).json({ error: 'Expected an array of category rules' });
            return;
        }
        db.prepare(`INSERT INTO settings (key, value, updatedAt) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updatedAt = excluded.updatedAt`).run('ebay_category_rules', JSON.stringify(rules));
        info(`[API] eBay category rules updated (${rules.length} rules)`);
        res.json({ ok: true });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to save eBay categories', detail: String(err) });
    }
});
/** POST /api/sync/products — Sync Shopify products to eBay listings */
router.post('/api/sync/products', async (req, res) => {
    try {
        const db = await getRawDb();
        const dryRun = req.query.dry === 'true';
        const draft = req.body.draft === true || req.query.draft === 'true';
        const productIds = req.body.productIds;
        if (!Array.isArray(productIds) || productIds.length === 0) {
            res.status(400).json({ error: 'productIds array required in request body' });
            return;
        }
        // Get tokens
        const ebayToken = await getValidEbayToken();
        const shopifyRow = db.prepare(`SELECT access_token FROM auth_tokens WHERE platform = 'shopify'`).get();
        if (!ebayToken) {
            res.status(400).json({ error: 'eBay token not found. Complete OAuth first.' });
            return;
        }
        if (!shopifyRow?.access_token) {
            res.status(400).json({ error: 'Shopify token not found. Complete OAuth first.' });
            return;
        }
        // Get settings
        const settings = db.prepare(`SELECT * FROM settings`).all();
        const settingsObj = Object.fromEntries(settings.map((s) => [s.key, s.value]));
        info(`[API] Product sync triggered: ${productIds.length} products${dryRun ? ' (DRY RUN)' : ''}${draft ? ' (DRAFT)' : ''}`);
        res.json({ ok: true, message: 'Product sync triggered', productIds, dryRun, draft });
        // Run sync in background
        try {
            const { syncProducts } = await import('../../sync/product-sync.js');
            const result = await syncProducts(ebayToken, shopifyRow.access_token, productIds, settingsObj, { dryRun, draft });
            info(`[API] Product sync complete: ${result.created} created, ${result.skipped} skipped, ${result.failed} failed`);
        }
        catch (err) {
            info(`[API] Product sync error: ${err}`);
        }
    }
    catch (err) {
        res.status(500).json({ error: 'Product sync failed', detail: String(err) });
    }
});
/** GET /api/sync/inventory — Latest inventory sync status */
router.get('/api/sync/inventory', async (_req, res) => {
    try {
        const db = await getRawDb();
        const last = db.prepare(`SELECT * FROM sync_log WHERE entity_type = 'inventory' ORDER BY id DESC LIMIT 1`).get();
        res.json({
            ok: true,
            lastSync: last ?? null,
        });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to fetch inventory status', detail: String(err) });
    }
});
/** POST /api/sync/inventory — Sync inventory levels Shopify → eBay */
router.post('/api/sync/inventory', async (req, res) => {
    try {
        const db = await getRawDb();
        const dryRun = req.query.dry === 'true';
        // Get tokens
        const ebayToken = await getValidEbayToken();
        const shopifyRow = db.prepare(`SELECT access_token FROM auth_tokens WHERE platform = 'shopify'`).get();
        if (!ebayToken) {
            res.status(400).json({ error: 'eBay token not found. Complete OAuth first.' });
            return;
        }
        if (!shopifyRow?.access_token) {
            res.status(400).json({ error: 'Shopify token not found. Complete OAuth first.' });
            return;
        }
        info(`[API] Inventory sync triggered${dryRun ? ' (DRY RUN)' : ''}`);
        res.json({ ok: true, message: 'Inventory sync triggered', dryRun });
        // Run sync in background
        try {
            const { syncAllInventory } = await import('../../sync/inventory-sync.js');
            const result = await syncAllInventory(ebayToken, shopifyRow.access_token, { dryRun });
            info(`[API] Inventory sync complete: ${result.updated} updated, ${result.skipped} skipped, ${result.failed} failed`);
        }
        catch (err) {
            info(`[API] Inventory sync error: ${err}`);
        }
    }
    catch (err) {
        res.status(500).json({ error: 'Inventory sync failed', detail: String(err) });
    }
});
/** POST /api/sync/prices — Sync Shopify prices to eBay */
router.post('/api/sync/prices', async (req, res) => {
    try {
        const db = await getRawDb();
        const dryRun = req.query.dry === 'true';
        // Get tokens
        const ebayToken = await getValidEbayToken();
        const shopifyRow = db.prepare(`SELECT access_token FROM auth_tokens WHERE platform = 'shopify'`).get();
        if (!ebayToken) {
            res.status(400).json({ error: 'eBay token not found. Complete OAuth first.' });
            return;
        }
        if (!shopifyRow?.access_token) {
            res.status(400).json({ error: 'Shopify token not found. Complete OAuth first.' });
            return;
        }
        info(`[API] Price sync triggered${dryRun ? ' (DRY RUN)' : ''}`);
        res.json({ ok: true, message: 'Price sync triggered', dryRun });
        // Run sync in background
        try {
            const { syncPrices } = await import('../../sync/price-sync.js');
            const result = await syncPrices(ebayToken, shopifyRow.access_token, { dryRun });
            info(`[API] Price sync complete: ${result.updated} updated, ${result.skipped} skipped, ${result.failed} failed`);
        }
        catch (err) {
            info(`[API] Price sync error: ${err}`);
        }
    }
    catch (err) {
        res.status(500).json({ error: 'Price sync failed', detail: String(err) });
    }
});
/** POST /api/sync/inventory/:sku — Sync specific SKU inventory from Shopify to eBay */
router.post('/api/sync/inventory/:sku', async (req, res) => {
    try {
        const db = await getRawDb();
        const sku = Array.isArray(req.params.sku) ? req.params.sku[0] : req.params.sku;
        const quantity = req.body.quantity;
        if (quantity === undefined || quantity === null) {
            res.status(400).json({ error: 'quantity required in request body' });
            return;
        }
        // Get eBay token
        const ebayToken = await getValidEbayToken();
        if (!ebayToken) {
            res.status(400).json({ error: 'eBay token not found.' });
            return;
        }
        info(`[API] Single inventory sync: ${sku} → ${quantity}`);
        const { updateEbayInventory } = await import('../../sync/inventory-sync.js');
        const result = await updateEbayInventory(ebayToken, sku, quantity);
        res.json({ ok: result.success, sku, quantity, action: result.action, error: result.error });
    }
    catch (err) {
        res.status(500).json({ error: 'Inventory sync failed', detail: String(err) });
    }
});
/** POST /api/test/update-price — Update test product price in Shopify */
router.post('/api/test/update-price', async (req, res) => {
    try {
        const db = await getRawDb();
        const tokenRow = db.prepare(`SELECT access_token FROM auth_tokens WHERE platform = 'shopify'`).get();
        if (!tokenRow?.access_token) {
            res.status(400).json({ error: 'No Shopify token' });
            return;
        }
        const productId = req.body.productId;
        const variantId = req.body.variantId;
        const price = req.body.price;
        if (!productId || !variantId || !price) {
            res.status(400).json({ error: 'productId, variantId, and price required' });
            return;
        }
        const response = await fetch(`https://usedcameragear.myshopify.com/admin/api/2024-01/variants/${variantId}.json`, {
            method: 'PUT',
            headers: {
                'X-Shopify-Access-Token': tokenRow.access_token,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ variant: { id: variantId, price } }),
        });
        if (!response.ok) {
            const errText = await response.text();
            res.status(500).json({ error: 'Failed to update price', detail: errText });
            return;
        }
        const data = await response.json();
        info(`[API] Test product price updated: variant ${variantId} → $${price}`);
        res.json({ ok: true, variant: data.variant });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed', detail: String(err) });
    }
});
/** POST /api/test/update-inventory — Update test product inventory in Shopify */
router.post('/api/test/update-inventory', async (req, res) => {
    try {
        const db = await getRawDb();
        const tokenRow = db.prepare(`SELECT access_token FROM auth_tokens WHERE platform = 'shopify'`).get();
        if (!tokenRow?.access_token) {
            res.status(400).json({ error: 'No Shopify token' });
            return;
        }
        const inventoryItemId = req.body.inventoryItemId;
        const locationId = req.body.locationId;
        const quantity = req.body.quantity;
        if (!inventoryItemId || !locationId || quantity === undefined) {
            res.status(400).json({ error: 'inventoryItemId, locationId, and quantity required' });
            return;
        }
        // Shopify requires "set" operation with inventory_levels/set
        const response = await fetch('https://usedcameragear.myshopify.com/admin/api/2024-01/inventory_levels/set.json', {
            method: 'POST',
            headers: {
                'X-Shopify-Access-Token': tokenRow.access_token,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                location_id: locationId,
                inventory_item_id: inventoryItemId,
                available: quantity,
            }),
        });
        if (!response.ok) {
            const errText = await response.text();
            res.status(500).json({ error: 'Failed to update inventory', detail: errText });
            return;
        }
        const data = await response.json();
        info(`[API] Test product inventory updated: item ${inventoryItemId} → ${quantity}`);
        res.json({ ok: true, inventoryLevel: data.inventory_level });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed', detail: String(err) });
    }
});
/** GET /api/test/product-info/:productId — Get full Shopify product details for testing */
router.get('/api/test/product-info/:productId', async (req, res) => {
    try {
        const db = await getRawDb();
        const tokenRow = db.prepare(`SELECT access_token FROM auth_tokens WHERE platform = 'shopify'`).get();
        if (!tokenRow?.access_token) {
            res.status(400).json({ error: 'No Shopify token' });
            return;
        }
        const productId = Array.isArray(req.params.productId) ? req.params.productId[0] : req.params.productId;
        const product = await fetchDetailedShopifyProduct(tokenRow.access_token, productId);
        if (!product) {
            res.status(404).json({ error: 'Product not found in Shopify' });
            return;
        }
        const variant = product.variants?.[0];
        const images = product.images.map((img) => ({ id: Number(img.id), src: img.url, alt: img.altText }));
        res.json({
            ok: true,
            product: {
                id: product.id,
                title: product.title,
                status: product.status,
                body_html: product.descriptionHtml,
                product_type: product.productType,
                vendor: product.vendor,
                tags: product.tags.join(', '),
                images,
                image: images[0] ?? null,
                variants: product.variants.map((v) => ({
                    id: Number(v.id),
                    sku: v.sku,
                    price: v.price,
                    compare_at_price: v.compareAtPrice ?? null,
                    inventory_quantity: v.inventoryQuantity,
                    weight: v.weight,
                    weight_unit: v.weightUnit,
                    requires_shipping: v.requiresShipping,
                })),
                variant: variant
                    ? {
                        id: Number(variant.id),
                        sku: variant.sku,
                        price: variant.price,
                        compare_at_price: variant.compareAtPrice ?? null,
                        inventory_quantity: variant.inventoryQuantity,
                        weight: variant.weight,
                        weight_unit: variant.weightUnit,
                        requires_shipping: variant.requiresShipping,
                    }
                    : null,
            },
        });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed', detail: String(err) });
    }
});
/** GET /api/test/shopify-locations — Get Shopify locations */
router.get('/api/test/shopify-locations', async (_req, res) => {
    try {
        const db = await getRawDb();
        const tokenRow = db.prepare(`SELECT access_token FROM auth_tokens WHERE platform = 'shopify'`).get();
        if (!tokenRow?.access_token) {
            res.status(400).json({ error: 'No Shopify token' });
            return;
        }
        const response = await fetch('https://usedcameragear.myshopify.com/admin/api/2024-01/locations.json', {
            headers: { 'X-Shopify-Access-Token': tokenRow.access_token },
        });
        if (!response.ok) {
            const errText = await response.text();
            res.status(500).json({ error: 'Failed to fetch locations', detail: errText });
            return;
        }
        const data = await response.json();
        res.json({ ok: true, locations: data.locations?.map((l) => ({ id: l.id, name: l.name, active: l.active })) || [] });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed', detail: String(err) });
    }
});
/** GET /api/test/ebay-offer/:sku — Get eBay offer details for a SKU */
router.get('/api/test/ebay-offer/:sku', async (req, res) => {
    try {
        const db = await getRawDb();
        const ebayToken = await getValidEbayToken();
        if (!ebayToken) {
            res.status(400).json({ error: 'No eBay token' });
            return;
        }
        const sku = Array.isArray(req.params.sku) ? req.params.sku[0] : req.params.sku;
        const { getOffersBySku, getInventoryItem } = await import('../../ebay/inventory.js');
        const [offers, inventoryItem] = await Promise.all([
            getOffersBySku(ebayToken, sku),
            getInventoryItem(ebayToken, sku),
        ]);
        const offer = offers.offers?.[0];
        res.json({
            ok: true,
            sku,
            inventoryItem: inventoryItem ? {
                quantity: inventoryItem.availability?.shipToLocationAvailability?.quantity,
                condition: inventoryItem.condition,
                title: inventoryItem.product?.title,
            } : null,
            offer: offer ? {
                offerId: offer.offerId,
                status: offer.status,
                listingId: offer.listingId,
                price: offer.pricingSummary?.price?.value,
                quantity: offer.availableQuantity,
                format: offer.format,
            } : null,
        });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed', detail: String(err) });
    }
});
/** PUT /api/sync/products/:productId — Update existing eBay listing from Shopify */
router.put('/api/sync/products/:productId', async (req, res) => {
    try {
        const db = await getRawDb();
        const productId = Array.isArray(req.params.productId) ? req.params.productId[0] : req.params.productId;
        const ebayToken = await getValidEbayToken();
        const shopifyRow = db.prepare(`SELECT access_token FROM auth_tokens WHERE platform = 'shopify'`).get();
        if (!ebayToken || !shopifyRow?.access_token) {
            res.status(400).json({ error: 'Missing eBay or Shopify token' });
            return;
        }
        const settings = db.prepare(`SELECT * FROM settings`).all();
        const settingsObj = Object.fromEntries(settings.map((s) => [s.key, s.value]));
        const { updateProductOnEbay } = await import('../../sync/product-sync.js');
        const result = await updateProductOnEbay(ebayToken, shopifyRow.access_token, productId, settingsObj);
        res.json({ ok: result.success, productId, updated: result.updated, error: result.error });
    }
    catch (err) {
        res.status(500).json({ error: 'Product update failed', detail: String(err) });
    }
});
/** POST /api/sync/products/:productId/end — End an eBay listing (product archived/deleted) */
router.post('/api/sync/products/:productId/end', async (req, res) => {
    try {
        const db = await getRawDb();
        const productId = Array.isArray(req.params.productId) ? req.params.productId[0] : req.params.productId;
        const ebayToken = await getValidEbayToken();
        if (!ebayToken) {
            res.status(400).json({ error: 'No eBay token' });
            return;
        }
        const { endEbayListing } = await import('../../sync/product-sync.js');
        const result = await endEbayListing(ebayToken, productId);
        res.json({ ok: result.success, productId, error: result.error });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to end listing', detail: String(err) });
    }
});
/** POST /api/test/update-product — Update test product title/status in Shopify */
router.post('/api/test/update-product', async (req, res) => {
    try {
        const db = await getRawDb();
        const tokenRow = db.prepare(`SELECT access_token FROM auth_tokens WHERE platform = 'shopify'`).get();
        if (!tokenRow?.access_token) {
            res.status(400).json({ error: 'No Shopify token' });
            return;
        }
        const productId = req.body.productId;
        const updates = {};
        if (req.body.title)
            updates.title = req.body.title;
        if (req.body.status)
            updates.status = req.body.status;
        if (req.body.body_html)
            updates.body_html = req.body.body_html;
        if (!productId || Object.keys(updates).length === 0) {
            res.status(400).json({ error: 'productId and at least one field (title, status, body_html) required' });
            return;
        }
        const response = await fetch(`https://usedcameragear.myshopify.com/admin/api/2024-01/products/${productId}.json`, {
            method: 'PUT',
            headers: {
                'X-Shopify-Access-Token': tokenRow.access_token,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ product: { id: productId, ...updates } }),
        });
        if (!response.ok) {
            const errText = await response.text();
            res.status(500).json({ error: 'Failed to update product', detail: errText });
            return;
        }
        const data = await response.json();
        info(`[API] Test product updated: ${productId} — ${JSON.stringify(updates)}`);
        res.json({ ok: true, product: { id: data.product.id, title: data.product.title, status: data.product.status } });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed', detail: String(err) });
    }
});
/** POST /api/listings/link — Manually link eBay listing to Shopify product */
router.post('/api/listings/link', async (req, res) => {
    try {
        const { shopifyProductId, ebayListingId, sku } = req.body;
        if (!shopifyProductId || !ebayListingId || !sku) {
            res.status(400).json({ error: 'shopifyProductId, ebayListingId, and sku are required' });
            return;
        }
        const db = await getRawDb();
        // Check if already linked
        const existing = db.prepare(`SELECT * FROM product_mappings WHERE shopify_product_id = ? OR ebay_listing_id = ?`).get(shopifyProductId, ebayListingId);
        if (existing) {
            res.status(400).json({ error: 'Product or listing already linked' });
            return;
        }
        // Create mapping
        db.prepare(`INSERT INTO product_mappings (shopify_product_id, ebay_listing_id, ebay_inventory_item_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', datetime('now'), datetime('now'))`).run(shopifyProductId, ebayListingId, sku);
        info(`[API] Manually linked: Shopify ${shopifyProductId} ↔ eBay ${ebayListingId} (SKU: ${sku})`);
        res.json({ ok: true, message: 'Listing linked successfully' });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to link listing', detail: String(err) });
    }
});
/** GET /api/mappings — List all mappings grouped by category */
router.get('/api/mappings', async (_req, res) => {
    try {
        const { getAllMappings } = await import('../../sync/attribute-mapping-service.js');
        const mappings = await getAllMappings();
        res.json(mappings);
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to fetch mappings', detail: String(err) });
    }
});
/** GET /api/mappings/:category — List mappings for a category (sales/listing/payment/shipping) */
router.get('/api/mappings/:category', async (req, res) => {
    try {
        const category = Array.isArray(req.params.category) ? req.params.category[0] : req.params.category;
        const { getMappingsByCategory } = await import('../../sync/attribute-mapping-service.js');
        const mappings = await getMappingsByCategory(category);
        res.json({ data: mappings });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to fetch mappings', detail: String(err) });
    }
});
/** PUT /api/mappings/:category/:field_name — Update a single mapping */
router.put('/api/mappings/:category/:field_name', async (req, res) => {
    try {
        const category = Array.isArray(req.params.category) ? req.params.category[0] : req.params.category;
        const fieldName = Array.isArray(req.params.field_name) ? req.params.field_name[0] : req.params.field_name;
        const { mapping_type, source_value, target_value, variation_mapping, is_enabled } = req.body;
        const { updateMapping } = await import('../../sync/attribute-mapping-service.js');
        const mapping = await updateMapping(category, fieldName, {
            mapping_type,
            source_value,
            target_value,
            variation_mapping,
            is_enabled: is_enabled !== undefined ? Boolean(is_enabled) : undefined,
        });
        if (!mapping) {
            res.status(404).json({ error: 'Mapping not found or no changes made' });
            return;
        }
        info(`[API] Updated mapping ${category}.${fieldName}: ${JSON.stringify(req.body)}`);
        res.json(mapping);
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to update mapping', detail: String(err) });
    }
});
/** POST /api/mappings/bulk — Update multiple mappings at once */
router.post('/api/mappings/bulk', async (req, res) => {
    try {
        const { mappings } = req.body;
        if (!Array.isArray(mappings)) {
            res.status(400).json({ error: 'mappings array is required' });
            return;
        }
        const { updateMappingsBulk } = await import('../../sync/attribute-mapping-service.js');
        const result = await updateMappingsBulk(mappings);
        info(`[API] Bulk update complete: ${result.updated} updated, ${result.failed} failed`);
        res.json(result);
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to bulk update mappings', detail: String(err) });
    }
});
/** GET /api/mappings/export — Export all mappings as JSON (for backup) */
router.get('/api/mappings/export', async (_req, res) => {
    try {
        const { exportMappings } = await import('../../sync/attribute-mapping-service.js');
        const mappings = await exportMappings();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename=attribute-mappings.json');
        res.json(mappings);
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to export mappings', detail: String(err) });
    }
});
/** POST /api/mappings/import — Import mappings from JSON */
router.post('/api/mappings/import', async (req, res) => {
    try {
        const { mappings } = req.body;
        if (!Array.isArray(mappings)) {
            res.status(400).json({ error: 'mappings array is required' });
            return;
        }
        const { importMappings } = await import('../../sync/attribute-mapping-service.js');
        const result = await importMappings(mappings);
        info(`[API] Import complete: ${result.imported} imported, ${result.updated} updated`);
        res.json(result);
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to import mappings', detail: String(err) });
    }
});
/** GET /api/product-overrides/:shopifyProductId — Get per-product overrides */
router.get('/api/product-overrides/:shopifyProductId', async (req, res) => {
    try {
        const { shopifyProductId } = req.params;
        const { getProductOverrides } = await import('../../sync/attribute-mapping-service.js');
        const overrides = await getProductOverrides(shopifyProductId);
        res.json({ data: overrides });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to fetch product overrides', detail: String(err) });
    }
});
/** PUT /api/product-overrides/:shopifyProductId — Save per-product overrides */
router.put('/api/product-overrides/:shopifyProductId', async (req, res) => {
    try {
        const { shopifyProductId } = req.params;
        const { overrides } = req.body;
        if (!Array.isArray(overrides)) {
            res.status(400).json({ error: 'overrides array is required' });
            return;
        }
        const { saveProductOverridesBulk } = await import('../../sync/attribute-mapping-service.js');
        const count = await saveProductOverridesBulk(shopifyProductId, overrides);
        res.json({ ok: true, saved: count });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to save product overrides', detail: String(err) });
    }
});
/**
 * POST /api/sync/trigger — Manually trigger an order sync
 *
 * ⚠️  DRY RUN BY DEFAULT — no Shopify orders will be created unless confirm=true.
 *
 * Query params:
 *   since=<ISO date>   — Only sync orders after this date (max 7-day lookback enforced)
 *   confirm=true       — REQUIRED to actually create Shopify orders; omit for dry run
 *   dry=true           — Deprecated alias; use confirm=true instead
 *
 * WARNING: Creating Shopify orders cascades into Lightspeed POS.
 * See AGENTS.md and PROJECT.md for the full incident history.
 */
router.post('/api/sync/trigger', async (req, res) => {
    const normalizeSince = (value) => {
        if (!value)
            return undefined;
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime()))
            return undefined;
        return parsed.toISOString();
    };
    const bodySince = typeof req.body?.since === 'string'
        ? req.body.since
        : typeof req.body?.startDate === 'string'
            ? req.body.startDate
            : undefined;
    const since = normalizeSince(req.query.since ?? bodySince);
    // confirm=true is required to create real orders. Everything else is a dry run.
    const confirm = req.query.confirm === 'true';
    const legacyDryRunFlag = req.query.dry;
    // Backward compat: if ?dry=false was explicitly passed treat as live (but confirm is preferred)
    const isLiveRun = confirm || legacyDryRunFlag === 'false';
    if (!isLiveRun) {
        info(`[API] Sync triggered in DRY RUN mode${since ? ` (since: ${since})` : ''}. Pass ?confirm=true to create real orders.`);
    }
    else {
        info(`[API] ⚠️  LIVE sync triggered${since ? ` (since: ${since})` : ''}. Will create real Shopify orders.`);
    }
    res.json({
        ok: true,
        message: isLiveRun ? 'Live sync triggered — Shopify orders WILL be created' : 'Dry-run sync triggered — no Shopify orders will be created',
        since: since || null,
        dryRun: !isLiveRun,
        confirm: isLiveRun,
        warning: isLiveRun
            ? '⚠️ Creating Shopify orders cascades into Lightspeed POS. Duplicates require manual cleanup.'
            : undefined,
    });
    try {
        const { runOrderSync } = await import('../sync-helper.js');
        const result = await runOrderSync({
            confirm: isLiveRun,
            since: since || undefined,
        });
        info(`[API] Sync complete (${isLiveRun ? 'LIVE' : 'DRY RUN'}): ` +
            `${result?.imported ?? 0} orders ${isLiveRun ? 'created' : 'would-create'}, ` +
            `${result?.skipped ?? 0} skipped, ${result?.failed ?? 0} failed, ` +
            `${result?.safetyBlocks?.length ?? 0} safety blocks`);
    }
    catch (err) {
        info(`[API] Sync error: ${err}`);
    }
});
/** POST /api/orders/cleanup — Delete all synced orders from Shopify and clear local DB */
router.post('/api/orders/cleanup', async (req, res) => {
    try {
        const db = await getRawDb();
        const dryRun = req.query.dry === 'true';
        // Get Shopify access token
        const tokenRow = db.prepare(`SELECT access_token FROM auth_tokens WHERE platform = 'shopify'`).get();
        if (!tokenRow?.access_token) {
            res.status(400).json({ error: 'No Shopify token found. Complete OAuth first.' });
            return;
        }
        // Get all synced order IDs
        const orders = db.prepare(`SELECT id, shopify_order_id, shopify_order_name FROM order_mappings ORDER BY id`).all();
        if (dryRun) {
            res.json({ dryRun: true, count: orders.length, orders: orders.map(o => o.shopify_order_name) });
            return;
        }
        const results = [];
        let deleted = 0;
        let failed = 0;
        for (const order of orders) {
            try {
                // First cancel the order (required before delete)
                await fetch(`https://usedcameragear.myshopify.com/admin/api/2024-01/orders/${order.shopify_order_id}/cancel.json`, {
                    method: 'POST',
                    headers: {
                        'X-Shopify-Access-Token': tokenRow.access_token,
                        'Content-Type': 'application/json',
                    },
                });
                // Then delete it
                const delRes = await fetch(`https://usedcameragear.myshopify.com/admin/api/2024-01/orders/${order.shopify_order_id}.json`, {
                    method: 'DELETE',
                    headers: { 'X-Shopify-Access-Token': tokenRow.access_token },
                });
                if (delRes.ok || delRes.status === 404) {
                    deleted++;
                    results.push({ id: order.shopify_order_id, name: order.shopify_order_name, status: 'deleted' });
                }
                else {
                    const errText = await delRes.text();
                    failed++;
                    results.push({ id: order.shopify_order_id, name: order.shopify_order_name, status: 'failed', error: errText });
                }
                // Rate limit: Shopify allows 2 req/sec
                await new Promise(r => setTimeout(r, 600));
            }
            catch (err) {
                failed++;
                results.push({ id: order.shopify_order_id, name: order.shopify_order_name, status: 'error', error: String(err) });
            }
        }
        // Clear local order mappings and sync log
        db.prepare(`DELETE FROM order_mappings`).run();
        db.prepare(`DELETE FROM sync_log`).run();
        info(`[API] Cleanup complete: ${deleted} deleted, ${failed} failed out of ${orders.length}`);
        res.json({ ok: true, total: orders.length, deleted, failed, results: results.slice(0, 10) });
    }
    catch (err) {
        res.status(500).json({ error: 'Cleanup failed', detail: String(err) });
    }
});
/** POST /api/test/create-product — Create a test product in Shopify for sync testing */
router.post('/api/test/create-product', async (req, res) => {
    try {
        const db = await getRawDb();
        const tokenRow = db.prepare(`SELECT access_token FROM auth_tokens WHERE platform = 'shopify'`).get();
        if (!tokenRow?.access_token) {
            res.status(400).json({ error: 'No Shopify token' });
            return;
        }
        const title = req.body.title || 'Camera Cleaning Kit - Basic';
        const price = req.body.price || '19.99';
        const inventory = parseInt(req.body.inventory) || 3;
        const sku = req.body.sku || `TEST-${Date.now()}`;
        const bodyHtml = req.body.body_html || `<p>Basic camera cleaning kit. Includes lens cloth, blower, and brush.</p>`;
        const vendor = req.body.vendor || 'Pictureline';
        const productType = req.body.product_type || 'Accessories';
        const tags = req.body.tags || 'test,ebay-sync-test,Used';
        const images = req.body.images || [];
        const product = {
            product: {
                title,
                body_html: bodyHtml,
                vendor,
                product_type: productType,
                tags,
                variants: [{
                        price,
                        sku,
                        inventory_management: 'shopify',
                        inventory_quantity: inventory,
                        barcode: '0000000000000',
                    }],
                images: images.length > 0 ? images : undefined,
                status: 'active',
            },
        };
        const response = await fetch('https://usedcameragear.myshopify.com/admin/api/2024-01/products.json', {
            method: 'POST',
            headers: {
                'X-Shopify-Access-Token': tokenRow.access_token,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(product),
        });
        if (!response.ok) {
            const errText = await response.text();
            res.status(500).json({ error: 'Failed to create product', detail: errText });
            return;
        }
        const data = await response.json();
        info(`[API] Test product created: ${data.product.id} — ${data.product.title}`);
        res.json({ ok: true, product: { id: data.product.id, title: data.product.title, variants: data.product.variants } });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed', detail: String(err) });
    }
});
/** POST /api/test/add-image — Add an image to an existing Shopify product */
router.post('/api/test/add-image', async (req, res) => {
    try {
        const db = await getRawDb();
        const tokenRow = db.prepare(`SELECT access_token FROM auth_tokens WHERE platform = 'shopify'`).get();
        if (!tokenRow?.access_token) {
            res.status(400).json({ error: 'No Shopify token' });
            return;
        }
        const productId = req.body.productId;
        const imageUrl = req.body.imageUrl;
        const attachment = req.body.attachment; // base64 encoded image
        const filename = req.body.filename;
        if (!productId || (!imageUrl && !attachment)) {
            res.status(400).json({ error: 'productId and (imageUrl or attachment) required' });
            return;
        }
        const imagePayload = {};
        if (attachment) {
            imagePayload.attachment = attachment;
            if (filename)
                imagePayload.filename = filename;
        }
        else {
            imagePayload.src = imageUrl;
        }
        const response = await fetch(`https://usedcameragear.myshopify.com/admin/api/2024-01/products/${productId}/images.json`, {
            method: 'POST',
            headers: {
                'X-Shopify-Access-Token': tokenRow.access_token,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ image: imagePayload }),
        });
        if (!response.ok) {
            const errText = await response.text();
            res.status(500).json({ error: 'Failed to add image', detail: errText });
            return;
        }
        const data = await response.json();
        info(`[API] Image added to product ${productId}: ${data.image?.id}`);
        res.json({ ok: true, image: data.image });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed', detail: String(err) });
    }
});
/** DELETE /api/test/delete-product — Delete a product from Shopify + local DB */
router.delete('/api/test/delete-product', async (req, res) => {
    try {
        const db = await getRawDb();
        const tokenRow = db.prepare(`SELECT access_token FROM auth_tokens WHERE platform = 'shopify'`).get();
        if (!tokenRow?.access_token) {
            res.status(400).json({ error: 'No Shopify token' });
            return;
        }
        const productId = (req.query.productId || req.body?.productId);
        if (!productId) {
            res.status(400).json({ error: 'productId required' });
            return;
        }
        // Delete from Shopify (ignore 404 — may already be gone)
        const response = await fetch(`https://usedcameragear.myshopify.com/admin/api/2024-01/products/${productId}.json`, { method: 'DELETE', headers: { 'X-Shopify-Access-Token': tokenRow.access_token } });
        const shopifyDeleted = response.ok || response.status === 404;
        if (!shopifyDeleted) {
            const errText = await response.text();
            res.status(500).json({ error: 'Failed to delete from Shopify', detail: errText });
            return;
        }
        // Clean up local DB records
        db.prepare(`DELETE FROM product_mappings WHERE shopify_product_id = ?`).run(productId);
        db.prepare(`DELETE FROM product_mapping_overrides WHERE shopify_product_id = ?`).run(productId);
        db.prepare(`DELETE FROM sync_log WHERE entity_id = ?`).run(productId);
        info(`[API] Product ${productId} deleted from Shopify + local DB`);
        res.json({ ok: true, deleted: productId });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed', detail: String(err) });
    }
});
/** DELETE /api/test/delete-image — Delete an image from a Shopify product */
router.delete('/api/test/delete-image', async (req, res) => {
    try {
        const db = await getRawDb();
        const tokenRow = db.prepare(`SELECT access_token FROM auth_tokens WHERE platform = 'shopify'`).get();
        if (!tokenRow?.access_token) {
            res.status(400).json({ error: 'No Shopify token' });
            return;
        }
        const productId = (req.query.productId || req.body?.productId);
        const imageId = (req.query.imageId || req.body?.imageId);
        if (!productId || !imageId) {
            res.status(400).json({ error: 'productId and imageId required' });
            return;
        }
        const response = await fetch(`https://usedcameragear.myshopify.com/admin/api/2024-01/products/${productId}/images/${imageId}.json`, { method: 'DELETE', headers: { 'X-Shopify-Access-Token': tokenRow.access_token } });
        if (!response.ok) {
            const errText = await response.text();
            res.status(500).json({ error: 'Failed to delete image', detail: errText });
            return;
        }
        info(`[API] Image ${imageId} deleted from product ${productId}`);
        res.json({ ok: true });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed', detail: String(err) });
    }
});
/** PUT /api/products/:productId/images/:imageId — Replace a single Shopify product image */
router.put('/api/products/:productId/images/:imageId', async (req, res) => {
    try {
        const db = await getRawDb();
        const tokenRow = db.prepare(`SELECT access_token FROM auth_tokens WHERE platform = 'shopify'`).get();
        if (!tokenRow?.access_token) {
            res.status(400).json({ error: 'No Shopify token' });
            return;
        }
        const { productId, imageId } = req.params;
        const { attachment, imageUrl, filename, position } = req.body;
        if (!attachment && !imageUrl) {
            res.status(400).json({ error: 'attachment (base64) or imageUrl required' });
            return;
        }
        const headers = {
            'X-Shopify-Access-Token': tokenRow.access_token,
            'Content-Type': 'application/json',
        };
        const baseUrl = `https://usedcameragear.myshopify.com/admin/api/2024-01/products/${productId}`;
        // Get original image position before deleting
        let originalPosition = position;
        if (!originalPosition) {
            const getRes = await fetch(`${baseUrl}/images/${imageId}.json`, { headers });
            if (getRes.ok) {
                const getData = await getRes.json();
                originalPosition = getData.image?.position;
            }
        }
        // Delete old image
        const delRes = await fetch(`${baseUrl}/images/${imageId}.json`, {
            method: 'DELETE',
            headers,
        });
        if (!delRes.ok && delRes.status !== 404) {
            const errText = await delRes.text();
            res.status(500).json({ error: 'Failed to delete old image', detail: errText });
            return;
        }
        // Add new image
        const imagePayload = {};
        if (attachment) {
            imagePayload.attachment = attachment;
            if (filename)
                imagePayload.filename = filename;
        }
        else {
            imagePayload.src = imageUrl;
        }
        if (originalPosition) {
            imagePayload.position = originalPosition;
        }
        const addRes = await fetch(`${baseUrl}/images.json`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ image: imagePayload }),
        });
        if (!addRes.ok) {
            const errText = await addRes.text();
            res.status(500).json({ error: 'Failed to add replacement image', detail: errText });
            return;
        }
        const addData = await addRes.json();
        info(`[API] Replaced image ${imageId} on product ${productId} with new image ${addData.image?.id}`);
        res.json({ ok: true, image: addData.image });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed', detail: String(err) });
    }
});
// ---------------------------------------------------------------------------
// AI Listing Management Endpoints
// ---------------------------------------------------------------------------
/** POST /api/listings/republish-stale — Republish listings older than N days */
router.post('/api/listings/republish-stale', async (req, res) => {
    try {
        const db = await getRawDb();
        const maxAgeDays = parseInt(req.body.maxAgeDays) || 30;
        const ebayToken = await getValidEbayToken();
        if (!ebayToken) {
            res.status(400).json({ error: 'eBay token not found. Complete OAuth first.' });
            return;
        }
        info(`[API] Republish stale listings triggered (maxAge: ${maxAgeDays} days)`);
        res.json({ ok: true, message: `Republishing listings older than ${maxAgeDays} days`, maxAgeDays });
        // Run in background
        try {
            const { republishStaleListings } = await import('../../sync/listing-manager.js');
            const result = await republishStaleListings(ebayToken, maxAgeDays);
            info(`[API] Republish complete: ${result.republished} republished, ${result.skipped} skipped, ${result.failed} failed`);
        }
        catch (err) {
            info(`[API] Republish error: ${err}`);
        }
    }
    catch (err) {
        res.status(500).json({ error: 'Republish failed', detail: String(err) });
    }
});
/** POST /api/listings/apply-price-drops — Apply price drops to eligible listings */
router.post('/api/listings/apply-price-drops', async (req, res) => {
    try {
        const db = await getRawDb();
        const ebayToken = await getValidEbayToken();
        if (!ebayToken) {
            res.status(400).json({ error: 'eBay token not found. Complete OAuth first.' });
            return;
        }
        info(`[API] Price drop schedule triggered`);
        res.json({ ok: true, message: 'Applying price drops to eligible listings' });
        // Run in background
        try {
            const { applyPriceDropSchedule } = await import('../../sync/listing-manager.js');
            const result = await applyPriceDropSchedule(ebayToken);
            info(`[API] Price drops complete: ${result.dropped} dropped, ${result.skipped} skipped, ${result.failed} failed`);
        }
        catch (err) {
            info(`[API] Price drop error: ${err}`);
        }
    }
    catch (err) {
        res.status(500).json({ error: 'Price drop failed', detail: String(err) });
    }
});
/** GET /api/listings/stale — Get listings eligible for action (older than N days) */
router.get('/api/listings/stale', async (req, res) => {
    try {
        const maxAgeDays = parseInt(req.query.days) || 14;
        const { getStaleListings } = await import('../../sync/listing-manager.js');
        const listings = await getStaleListings(maxAgeDays);
        res.json({ data: listings, total: listings.length, maxAgeDays });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to fetch stale listings', detail: String(err) });
    }
});
/** GET /api/listings/health — Listing health dashboard data */
router.get('/api/listings/health', async (_req, res) => {
    try {
        const { getListingHealth } = await import('../../sync/listing-manager.js');
        const health = await getListingHealth();
        res.json(health);
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to fetch listing health', detail: String(err) });
    }
});
/** POST /api/listings/promote — Enable Promoted Listings for given listing IDs */
router.post('/api/listings/promote', async (req, res) => {
    try {
        const db = await getRawDb();
        const { listingIds, adRate } = req.body;
        if (!Array.isArray(listingIds) || listingIds.length === 0) {
            res.status(400).json({ error: 'listingIds array required in request body' });
            return;
        }
        const ebayToken = await getValidEbayToken();
        if (!ebayToken) {
            res.status(400).json({ error: 'eBay token not found. Complete OAuth first.' });
            return;
        }
        const effectiveRate = parseFloat(adRate) || 2.0;
        info(`[API] Promoted Listings triggered for ${listingIds.length} listings at ${effectiveRate}%`);
        res.json({ ok: true, message: `Promoting ${listingIds.length} listings at ${effectiveRate}% ad rate`, listingIds, adRate: effectiveRate });
        // Run in background
        try {
            const { enablePromotedListings } = await import('../../sync/listing-manager.js');
            const result = await enablePromotedListings(ebayToken, listingIds, effectiveRate);
            info(`[API] Promote complete: ${result.promoted} promoted, ${result.failed} failed`);
        }
        catch (err) {
            info(`[API] Promote error: ${err}`);
        }
    }
    catch (err) {
        res.status(500).json({ error: 'Promote failed', detail: String(err) });
    }
});
// ---------------------------------------------------------------------------
// Image Processing (PhotoRoom) Endpoints
// ---------------------------------------------------------------------------
/** GET /api/images/status — Check if PhotoRoom integration is configured */
router.get('/api/images/status', (_req, res) => {
    const apiKey = process.env.PHOTOROOM_API_KEY;
    res.json({
        configured: Boolean(apiKey),
        apiKey: Boolean(apiKey),
    });
});
/** POST /api/images/process/:shopifyProductId — Process product images through PhotoRoom */
router.post('/api/images/process/:shopifyProductId', async (req, res) => {
    try {
        const shopifyProductId = Array.isArray(req.params.shopifyProductId)
            ? req.params.shopifyProductId[0]
            : req.params.shopifyProductId;
        // Get Shopify token
        const db = await getRawDb();
        const tokenRow = db.prepare(`SELECT access_token FROM auth_tokens WHERE platform = 'shopify'`).get();
        if (!tokenRow?.access_token) {
            res.status(400).json({ error: 'No Shopify token. Complete OAuth first.' });
            return;
        }
        // Fetch the product from Shopify
        const productRes = await fetch(`https://usedcameragear.myshopify.com/admin/api/2024-01/products/${shopifyProductId}.json`, { headers: { 'X-Shopify-Access-Token': tokenRow.access_token } });
        if (!productRes.ok) {
            const errText = await productRes.text();
            res.status(500).json({ error: 'Failed to fetch product from Shopify', detail: errText });
            return;
        }
        const productData = (await productRes.json());
        const product = productData.product;
        if (!product?.images || product.images.length === 0) {
            res.status(400).json({ error: 'Product has no images to process' });
            return;
        }
        info(`[API] Image processing triggered for product ${shopifyProductId} (${product.images.length} images)`);
        // Process images through PhotoRoom
        const { processProductImages } = await import('../../services/image-processor.js');
        const processedUrls = await processProductImages(product);
        res.json({
            ok: true,
            productId: shopifyProductId,
            originalCount: product.images.length,
            processedCount: processedUrls.length,
            images: processedUrls,
        });
    }
    catch (err) {
        res.status(500).json({ error: 'Image processing failed', detail: String(err) });
    }
});
// ---------------------------------------------------------------------------
// Auto-Listing Pipeline Endpoints
// ---------------------------------------------------------------------------
/** POST /api/auto-list/batch — AI-generate descriptions + categories for multiple products */
router.post('/api/auto-list/batch', async (req, res) => {
    try {
        const { productIds } = req.body;
        if (!Array.isArray(productIds) || productIds.length === 0) {
            res.status(400).json({ error: 'productIds array required in request body' });
            return;
        }
        info(`[API] Auto-list batch triggered for ${productIds.length} products`);
        const { autoListProduct } = await import('../../sync/auto-listing-pipeline.js');
        const results = [];
        for (const productId of productIds) {
            const result = await autoListProduct(String(productId));
            results.push({ productId: String(productId), ...result });
        }
        const succeeded = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;
        info(`[API] Auto-list batch complete: ${succeeded} succeeded, ${failed} failed`);
        res.json({ ok: true, total: results.length, succeeded, failed, results });
    }
    catch (err) {
        res.status(500).json({ error: 'Auto-list batch failed', detail: String(err) });
    }
});
/** POST /api/auto-list/:shopifyProductId — AI-generate description + category for a product */
router.post('/api/auto-list/:shopifyProductId', async (req, res) => {
    try {
        const shopifyProductId = Array.isArray(req.params.shopifyProductId)
            ? req.params.shopifyProductId[0]
            : req.params.shopifyProductId;
        info(`[API] Auto-list triggered for product ${shopifyProductId}`);
        const { autoListProduct } = await import('../../sync/auto-listing-pipeline.js');
        const result = await autoListProduct(shopifyProductId);
        res.json({ ok: result.success, ...result });
    }
    catch (err) {
        res.status(500).json({ error: 'Auto-list failed', detail: String(err) });
    }
});
/** POST /api/admin/backfill-shopify-metadata — Backfill shopify_title/price/sku for existing products */
router.post('/api/admin/backfill-shopify-metadata', async (_req, res) => {
    try {
        const db = await getRawDb();
        const tokenRow = db.prepare(`SELECT access_token FROM auth_tokens WHERE platform = 'shopify'`).get();
        if (!tokenRow?.access_token) {
            res.status(400).json({ error: 'No Shopify token' });
            return;
        }
        const rows = db.prepare(`SELECT id, shopify_product_id FROM product_mappings WHERE shopify_title IS NULL`).all();
        let updated = 0;
        for (const row of rows) {
            try {
                const response = await fetch(`https://usedcameragear.myshopify.com/admin/api/2024-01/products/${row.shopify_product_id}.json`, { headers: { 'X-Shopify-Access-Token': tokenRow.access_token } });
                if (response.ok) {
                    const data = await response.json();
                    const product = data.product;
                    const variant = product.variants?.[0];
                    db.prepare(`UPDATE product_mappings SET shopify_title = ?, shopify_price = ?, shopify_sku = ?, updated_at = ? WHERE id = ?`).run(product.title || null, variant?.price ? parseFloat(variant.price) : null, variant?.sku || null, Math.floor(Date.now() / 1000), row.id);
                    updated++;
                }
            }
            catch { /* skip individual product errors */ }
        }
        info(`[Admin] Backfilled Shopify metadata for ${updated}/${rows.length} products`);
        res.json({ ok: true, updated, total: rows.length });
    }
    catch (err) {
        res.status(500).json({ error: 'Backfill failed', detail: String(err) });
    }
});
// ---------------------------------------------------------------------------
// Product Notes
// ---------------------------------------------------------------------------
/** GET /api/products/:productId/notes — get notes for a product */
router.get('/api/products/:productId/notes', async (req, res) => {
    try {
        const { productId } = req.params;
        const db = await getRawDb();
        const row = db
            .prepare(`SELECT product_notes FROM product_mappings WHERE shopify_product_id = ?`)
            .get(productId);
        res.json({ ok: true, notes: row?.product_notes ?? '' });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to get product notes', detail: String(err) });
    }
});
/** PUT /api/products/:productId/notes — save notes for a product */
router.put('/api/products/:productId/notes', async (req, res) => {
    try {
        const { productId } = req.params;
        const { notes } = req.body;
        const db = await getRawDb();
        // Check if row exists
        const existing = db
            .prepare(`SELECT id FROM product_mappings WHERE shopify_product_id = ?`)
            .get(productId);
        if (existing) {
            db.prepare(`UPDATE product_mappings SET product_notes = ?, updated_at = unixepoch() WHERE shopify_product_id = ?`).run(notes ?? '', productId);
        }
        else {
            db.prepare(`INSERT INTO product_mappings (shopify_product_id, ebay_listing_id, product_notes, created_at, updated_at) VALUES (?, '', ?, unixepoch(), unixepoch())`).run(productId, notes ?? '');
        }
        res.json({ ok: true });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to save product notes', detail: String(err) });
    }
});
// Note: /api/ebay/categories and /api/ebay/condition-descriptions are
// served by src/server/routes/ebay-metadata.ts (registered separately).
export default router;
