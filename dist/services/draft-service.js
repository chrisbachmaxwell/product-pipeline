/**
 * Draft Service — manages product drafts for the staging/review system.
 *
 * CRITICAL: The pipeline must NEVER overwrite live Shopify product data automatically.
 * All processed content goes through the draft system first.
 */
import { getRawDb } from '../db/client.js';
import { info, warn, error as logError } from '../utils/logger.js';
import { loadShopifyCredentials } from '../config/credentials.js';
// ── Markdown → HTML converter ──────────────────────────────────────────
// Converts the AI-generated markdown descriptions to HTML for Shopify's body_html field.
function markdownToHtml(md) {
    // Strip unwanted labels from AI output
    let cleaned = md
        .replace(/^\*\*Title line:\*\*\s*/gm, '')
        .replace(/^Title line:\s*/gm, '')
        .replace(/^\*\*Intro:\*\*\s*/gm, '')
        .replace(/^Intro:\s*/gm, '');
    const lines = cleaned.split('\n');
    const htmlLines = [];
    let inList = false;
    for (const line of lines) {
        const trimmed = line.trim();
        // Empty line — close any open list
        if (!trimmed) {
            if (inList) {
                htmlLines.push('</ul>');
                inList = false;
            }
            continue;
        }
        // Headings: ## Heading
        if (/^#{1,3}\s+/.test(trimmed)) {
            if (inList) {
                htmlLines.push('</ul>');
                inList = false;
            }
            const text = trimmed.replace(/^#{1,3}\s+/, '');
            htmlLines.push(`<h3>${inlineMd(text)}</h3>`);
            continue;
        }
        // Standalone bold label lines: **Key Features:** or **Condition: Excellent Plus**
        // These start and end with ** and have no other content after the closing **
        if (/^\*\*[^*]+\*\*\s*$/.test(trimmed)) {
            if (inList) {
                htmlLines.push('</ul>');
                inList = false;
            }
            htmlLines.push(`<h3>${inlineMd(trimmed)}</h3>`);
            continue;
        }
        // Bullet lines: - item, • item, ✔ item, ✔️ item (but NOT **bold** lines)
        const bulletMatch = trimmed.match(/^(?:[-•]|✔️?)\s+(.*)/);
        if (bulletMatch) {
            if (!inList) {
                htmlLines.push('<ul>');
                inList = true;
            }
            htmlLines.push(`<li>${inlineMd(bulletMatch[1])}</li>`);
            continue;
        }
        // Regular paragraph line
        if (inList) {
            htmlLines.push('</ul>');
            inList = false;
        }
        htmlLines.push(`<p>${inlineMd(trimmed)}</p>`);
    }
    if (inList)
        htmlLines.push('</ul>');
    return htmlLines.join('\n');
}
// Inline markdown: **bold**, *italic*, `code`
function inlineMd(text) {
    return text
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>')
        .replace(/`(.+?)`/g, '<code>$1</code>');
}
// ── Core CRUD ──────────────────────────────────────────────────────────
/**
 * Create a draft for a Shopify product. If a pending draft already exists
 * for this product, it will be updated instead.
 */
export async function createDraft(shopifyProductId, input) {
    const db = await getRawDb();
    const now = Math.floor(Date.now() / 1000);
    // Check for existing pending draft
    const existing = db.prepare(`SELECT id FROM product_drafts WHERE shopify_product_id = ? AND status = 'pending'`).get(shopifyProductId);
    if (existing) {
        // Update existing draft
        db.prepare(`UPDATE product_drafts SET
        draft_title = COALESCE(?, draft_title),
        draft_description = COALESCE(?, draft_description),
        draft_images_json = COALESCE(?, draft_images_json),
        original_title = COALESCE(?, original_title),
        original_description = COALESCE(?, original_description),
        original_images_json = COALESCE(?, original_images_json),
        tags = COALESCE(?, tags),
        updated_at = ?
      WHERE id = ?`).run(input.title ?? null, input.description ?? null, input.images ? JSON.stringify(input.images) : null, input.originalTitle ?? null, input.originalDescription ?? null, input.originalImages ? JSON.stringify(input.originalImages) : null, input.tags ? JSON.stringify(input.tags) : null, now, existing.id);
        info(`[DraftService] Updated existing draft ${existing.id} for product ${shopifyProductId}`);
        return existing.id;
    }
    // Create new draft
    const result = db.prepare(`INSERT INTO product_drafts
      (shopify_product_id, draft_title, draft_description, draft_images_json,
       original_title, original_description, original_images_json,
       tags, status, auto_publish, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`).run(shopifyProductId, input.title ?? null, input.description ?? null, input.images ? JSON.stringify(input.images) : null, input.originalTitle ?? null, input.originalDescription ?? null, input.originalImages ? JSON.stringify(input.originalImages) : null, input.tags ? JSON.stringify(input.tags) : null, now, now);
    const draftId = Number(result.lastInsertRowid);
    info(`[DraftService] Created draft ${draftId} for product ${shopifyProductId}`);
    return draftId;
}
/**
 * Get a single draft by ID.
 */
export async function getDraft(draftId) {
    const db = await getRawDb();
    const row = db.prepare(`SELECT * FROM product_drafts WHERE id = ?`).get(draftId);
    if (!row)
        return null;
    return parseDraft(row);
}
/**
 * Get the pending draft for a specific Shopify product.
 */
export async function getDraftByProduct(shopifyProductId) {
    const db = await getRawDb();
    const row = db.prepare(`SELECT * FROM product_drafts WHERE shopify_product_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`).get(shopifyProductId);
    if (!row)
        return null;
    return parseDraft(row);
}
/**
 * List all pending drafts (for the review queue).
 */
export async function listPendingDrafts(options) {
    const db = await getRawDb();
    const status = options?.status || 'pending';
    const limit = Math.min(options?.limit || 50, 200);
    const offset = options?.offset || 0;
    let whereClause = '';
    const params = [];
    if (status === 'all') {
        whereClause = '1=1';
    }
    else if (status.includes(',')) {
        const statuses = status.split(',').map(s => s.trim());
        whereClause = `status IN (${statuses.map(() => '?').join(',')})`;
        params.push(...statuses);
    }
    else {
        whereClause = 'status = ?';
        params.push(status);
    }
    const total = db.prepare(`SELECT COUNT(*) as count FROM product_drafts WHERE ${whereClause}`).get(...params);
    const rows = db.prepare(`SELECT * FROM product_drafts WHERE ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return {
        data: rows.map(parseDraft),
        total: total.count,
    };
}
export async function approveDraft(draftId, options) {
    const db = await getRawDb();
    const draft = db.prepare(`SELECT * FROM product_drafts WHERE id = ?`).get(draftId);
    if (!draft) {
        return { success: false, error: 'Draft not found' };
    }
    if (draft.status !== 'pending') {
        return { success: false, error: `Draft is already ${draft.status}` };
    }
    const now = Math.floor(Date.now() / 1000);
    try {
        // Get Shopify token
        const tokenRow = db.prepare(`SELECT access_token FROM auth_tokens WHERE platform = 'shopify'`).get();
        if (!tokenRow?.access_token) {
            return { success: false, error: 'Shopify token not found' };
        }
        const creds = await loadShopifyCredentials();
        const url = `https://${creds.storeDomain}/admin/api/2024-01/products/${draft.shopify_product_id}.json`;
        // Step 1: Push title/description — never includes published_at
        const updates = {};
        if (options.description && draft.draft_title) {
            updates.title = draft.draft_title;
        }
        if (options.description && draft.draft_description) {
            // Convert markdown to HTML — AI generates markdown but Shopify expects HTML
            updates.body_html = markdownToHtml(draft.draft_description);
        }
        if (Object.keys(updates).length > 0) {
            const response = await fetch(url, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Shopify-Access-Token': tokenRow.access_token,
                },
                body: JSON.stringify({ product: { id: draft.shopify_product_id, ...updates } }),
            });
            if (!response.ok) {
                const text = await response.text();
                logError(`[DraftService] Failed to update Shopify product: ${response.status} — ${text}`);
                return { success: false, error: `Shopify API error: ${response.status}` };
            }
            info(`[DraftService] ✅ Pushed description/title to Shopify product ${draft.shopify_product_id}`);
        }
        // Step 2: Publish — separate call, non-blocking
        let published = false;
        let publishError;
        if (options.publish === true) {
            try {
                const pubResponse = await fetch(url, {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Shopify-Access-Token': tokenRow.access_token,
                    },
                    body: JSON.stringify({ product: { id: draft.shopify_product_id, status: 'active', published_at: new Date().toISOString() } }),
                });
                const pubText = await pubResponse.text();
                info(`[Wizard] Shopify publish request for product ${draft.shopify_product_id} — status=${pubResponse.status}, body=${pubText.slice(0, 500)}`);
                if (pubResponse.ok) {
                    published = true;
                    info(`[Wizard] ✅ Published product ${draft.shopify_product_id} on Shopify (status: active)`);
                }
                else {
                    publishError = `Publish failed: ${pubResponse.status}`;
                    warn(`[Wizard] Publish failed (non-fatal): ${pubResponse.status} — ${pubText}`);
                }
            }
            catch (err) {
                publishError = String(err);
                warn(`[DraftService] Publish error (non-fatal): ${err}`);
            }
        }
        // Push images to Shopify
        if (options.photos && draft.draft_images_json) {
            const images = JSON.parse(draft.draft_images_json);
            if (images.length > 0) {
                const uploadResult = await uploadDraftImagesToShopify(tokenRow.access_token, creds.storeDomain, draft.shopify_product_id, images);
                info(`[DraftService] ✅ Uploaded ${uploadResult.uploaded} images to Shopify product ${draft.shopify_product_id}`);
            }
        }
        // Determine final status
        const newStatus = (options.photos && options.description) ? 'approved' : 'partial';
        db.prepare(`UPDATE product_drafts SET status = ?, reviewed_at = ?, reviewed_by = 'admin', updated_at = ? WHERE id = ?`).run(newStatus, now, now, draftId);
        info(`[DraftService] Draft ${draftId} ${newStatus} for product ${draft.shopify_product_id}`);
        return { success: true, published, publishError };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logError(`[DraftService] Approve error for draft ${draftId}: ${msg}`);
        return { success: false, error: msg };
    }
}
/**
 * Reject a draft.
 */
export async function rejectDraft(draftId) {
    const db = await getRawDb();
    const now = Math.floor(Date.now() / 1000);
    const draft = db.prepare(`SELECT id, status FROM product_drafts WHERE id = ?`).get(draftId);
    if (!draft)
        return { success: false, error: 'Draft not found' };
    if (draft.status !== 'pending')
        return { success: false, error: `Draft is already ${draft.status}` };
    db.prepare(`UPDATE product_drafts SET status = 'rejected', reviewed_at = ?, reviewed_by = 'admin', updated_at = ? WHERE id = ?`).run(now, now, draftId);
    info(`[DraftService] Draft ${draftId} rejected`);
    return { success: true };
}
/**
 * Update a draft's content before approving.
 */
export async function updateDraft(draftId, changes) {
    const db = await getRawDb();
    const now = Math.floor(Date.now() / 1000);
    const draft = db.prepare(`SELECT id, status FROM product_drafts WHERE id = ?`).get(draftId);
    if (!draft)
        return { success: false, error: 'Draft not found' };
    if (draft.status !== 'pending')
        return { success: false, error: `Cannot edit ${draft.status} draft` };
    const sets = ['updated_at = ?'];
    const params = [now];
    if (changes.title !== undefined) {
        sets.push('draft_title = ?');
        params.push(changes.title);
    }
    if (changes.description !== undefined) {
        sets.push('draft_description = ?');
        params.push(changes.description);
    }
    if (changes.images !== undefined) {
        sets.push('draft_images_json = ?');
        params.push(JSON.stringify(changes.images));
    }
    params.push(draftId);
    db.prepare(`UPDATE product_drafts SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    info(`[DraftService] Draft ${draftId} updated`);
    return { success: true };
}
/**
 * Get the pending draft count (for navigation badge).
 */
export async function getPendingDraftCount() {
    const db = await getRawDb();
    const row = db.prepare(`SELECT COUNT(*) as count FROM product_drafts WHERE status = 'pending'`).get();
    return row.count;
}
// ── Auto-Publish Settings ──────────────────────────────────────────────
/**
 * Check if a product type has auto-publish enabled.
 */
export async function getAutoPublishSetting(productType) {
    const db = await getRawDb();
    // Check global settings first
    const noPhotosAuto = db.prepare(`SELECT value FROM settings WHERE key = 'draft_auto_publish_no_photos'`).get();
    const noDescAuto = db.prepare(`SELECT value FROM settings WHERE key = 'draft_auto_publish_no_description'`).get();
    // Check per-type setting
    const typeSetting = db.prepare(`SELECT enabled FROM auto_publish_settings WHERE product_type = ?`).get(productType);
    return typeSetting?.enabled === 1;
}
/**
 * Toggle auto-publish for a product type.
 */
export async function setAutoPublishSetting(productType, enabled) {
    const db = await getRawDb();
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT INTO auto_publish_settings (product_type, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(product_type) DO UPDATE SET enabled = ?, updated_at = ?`).run(productType, enabled ? 1 : 0, now, now, enabled ? 1 : 0, now);
    info(`[DraftService] Auto-publish for "${productType}" set to ${enabled}`);
}
/**
 * Get all auto-publish settings.
 */
export async function getAllAutoPublishSettings() {
    const db = await getRawDb();
    const typeSettings = db.prepare(`SELECT * FROM auto_publish_settings`).all();
    const noPhotos = db.prepare(`SELECT value FROM settings WHERE key = 'draft_auto_publish_no_photos'`).get();
    const noDesc = db.prepare(`SELECT value FROM settings WHERE key = 'draft_auto_publish_no_description'`).get();
    return {
        perType: typeSettings.map((t) => ({
            product_type: t.product_type,
            enabled: t.enabled === 1,
        })),
        global: {
            autoPublishNoPhotos: noPhotos?.value === 'true',
            autoPublishNoDescription: noDesc?.value === 'true',
        },
    };
}
/**
 * Update global auto-publish settings.
 */
export async function updateGlobalAutoPublishSettings(settings) {
    const db = await getRawDb();
    if (settings.autoPublishNoPhotos !== undefined) {
        db.prepare(`INSERT INTO settings (key, value, updatedAt) VALUES ('draft_auto_publish_no_photos', ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = ?, updatedAt = datetime('now')`).run(String(settings.autoPublishNoPhotos), String(settings.autoPublishNoPhotos));
    }
    if (settings.autoPublishNoDescription !== undefined) {
        db.prepare(`INSERT INTO settings (key, value, updatedAt) VALUES ('draft_auto_publish_no_description', ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = ?, updatedAt = datetime('now')`).run(String(settings.autoPublishNoDescription), String(settings.autoPublishNoDescription));
    }
}
// ── Helpers ────────────────────────────────────────────────────────────
function parseDraft(row) {
    return {
        ...row,
        draftImages: row.draft_images_json ? JSON.parse(row.draft_images_json) : [],
        originalImages: row.original_images_json ? JSON.parse(row.original_images_json) : [],
        parsedTags: row.tags ? JSON.parse(row.tags) : [],
    };
}
/**
 * Upload draft images to Shopify product (replace semantics).
 * Supports both local file paths and URLs.
 */
async function uploadDraftImagesToShopify(accessToken, storeDomain, productId, images) {
    const { replaceProductImages } = await import('../shopify/images.js');
    const result = await replaceProductImages(accessToken, storeDomain, productId, images);
    return { uploaded: result.uploaded, failed: result.failed };
}
/**
 * Check if a Shopify product has existing content (photos and/or description).
 */
export async function checkExistingContent(shopifyProductId) {
    const db = await getRawDb();
    const tokenRow = db.prepare(`SELECT access_token FROM auth_tokens WHERE platform = 'shopify'`).get();
    if (!tokenRow?.access_token) {
        return { hasPhotos: false, hasDescription: false, title: '', description: '', images: [], tags: [] };
    }
    try {
        const creds = await loadShopifyCredentials();
        const url = `https://${creds.storeDomain}/admin/api/2024-01/products/${shopifyProductId}.json?fields=id,title,body_html,images,tags`;
        const response = await fetch(url, {
            headers: { 'X-Shopify-Access-Token': tokenRow.access_token },
        });
        if (!response.ok) {
            return { hasPhotos: false, hasDescription: false, title: '', description: '', images: [], tags: [] };
        }
        const data = (await response.json());
        const product = data.product;
        const description = product.body_html || '';
        const images = (product.images || []).map((img) => img.src);
        const tags = product.tags ? product.tags.split(',').map((t) => t.trim()) : [];
        return {
            hasPhotos: images.length > 0,
            hasDescription: description.trim().length > 0,
            title: product.title || '',
            description,
            images,
            tags,
        };
    }
    catch (err) {
        warn(`[DraftService] Failed to check existing content for ${shopifyProductId}: ${err}`);
        return { hasPhotos: false, hasDescription: false, title: '', description: '', images: [], tags: [] };
    }
}
/**
 * Fetch tags for multiple products in parallel.
 * Returns a map of shopify_product_id → tags array.
 */
export async function fetchProductTagsBatch(productIds) {
    if (productIds.length === 0)
        return {};
    const db = await getRawDb();
    const tokenRow = db.prepare(`SELECT access_token FROM auth_tokens WHERE platform = 'shopify'`).get();
    if (!tokenRow?.access_token)
        return {};
    const result = {};
    try {
        const creds = await loadShopifyCredentials();
        // Fetch in parallel, max 10 at a time
        const chunks = [];
        for (let i = 0; i < productIds.length; i += 10) {
            chunks.push(productIds.slice(i, i + 10));
        }
        for (const chunk of chunks) {
            const promises = chunk.map(async (pid) => {
                try {
                    const url = `https://${creds.storeDomain}/admin/api/2024-01/products/${pid}.json?fields=id,tags`;
                    const response = await fetch(url, {
                        headers: { 'X-Shopify-Access-Token': tokenRow.access_token },
                    });
                    if (!response.ok)
                        return;
                    const data = (await response.json());
                    result[pid] = data.product.tags
                        ? data.product.tags.split(',').map((t) => t.trim())
                        : [];
                }
                catch {
                    // Skip failed fetches
                }
            });
            await Promise.all(promises);
        }
    }
    catch (err) {
        warn(`[DraftService] Failed to batch fetch tags: ${err}`);
    }
    return result;
}
