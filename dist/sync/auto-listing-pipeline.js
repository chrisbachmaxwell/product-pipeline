import OpenAI from 'openai';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fetchDetailedShopifyProduct } from '../shopify/products.js';
import { saveProductOverride } from './attribute-mapping-service.js';
import { getRawDb } from '../db/client.js';
import { info, warn, error as logError } from '../utils/logger.js';
import { GRADE_DESCRIPTIONS } from '../config/condition-descriptions.js';
import { getImageService } from '../services/image-service-factory.js';
import { createPipelineJob, startPipelineJob, updatePipelineStep, setPipelineJobTitle, emitProgress, } from './pipeline-status.js';
import { createDraft, checkExistingContent, getAutoPublishSetting, approveDraft, } from '../services/draft-service.js';
// ---------------------------------------------------------------------------
// OpenAI client (lazy singleton) + retry helper
// ---------------------------------------------------------------------------
let openaiClient = null;
/** Retry an async fn up to `attempts` times with exponential backoff (1s, 2s, 4s). */
async function withRetry(fn, attempts = 3, label = 'OpenAI') {
    for (let i = 1; i <= attempts; i++) {
        try {
            return await fn();
        }
        catch (err) {
            const isLast = i === attempts;
            const status = err?.status ?? err?.response?.status;
            // Don't retry auth errors or bad requests
            if (status === 401 || status === 400)
                throw err;
            if (isLast)
                throw err;
            const delayMs = 1000 * Math.pow(2, i - 1);
            warn(`[${label}] Attempt ${i}/${attempts} failed (${err?.message ?? err}), retrying in ${delayMs}ms...`);
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
    throw new Error(`${label}: exhausted ${attempts} retries`);
}
function getOpenAI() {
    if (!openaiClient) {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            throw new Error('OPENAI_API_KEY environment variable is not set');
        }
        openaiClient = new OpenAI({ apiKey });
    }
    return openaiClient;
}
// ---------------------------------------------------------------------------
// processNewProduct — generate description + suggest eBay category via AI
// ---------------------------------------------------------------------------
export async function processNewProduct(shopifyProduct) {
    const openai = getOpenAI();
    const title = shopifyProduct.title || 'Unknown Product';
    const vendor = shopifyProduct.vendor || 'Unknown';
    const productId = shopifyProduct.id?.toString() || shopifyProduct.admin_graphql_api_id || '';
    // Fetch product notes if available
    let productNotes = '';
    try {
        const db = await getRawDb();
        const row = db
            .prepare(`SELECT product_notes FROM product_mappings WHERE shopify_product_id = ?`)
            .get(productId);
        productNotes = row?.product_notes ?? '';
    }
    catch {
        // Notes are optional — continue without them
    }
    // Look up TIM condition data for the product
    let timConditionText = '';
    try {
        const { findTimItemForProduct, formatConditionForPrompt } = await import('../services/tim-matching.js');
        const variants = shopifyProduct.variants ?? [];
        const skus = variants.map((v) => v.sku).filter(Boolean);
        const timData = await findTimItemForProduct(skus);
        if (timData) {
            timConditionText = formatConditionForPrompt(timData);
            info(`[AutoList] Found TIM condition for ${title}: ${timData.condition ?? 'ungraded'}`);
            // Store TIM condition for SSE visibility (accessed by caller)
            processNewProduct.__lastTimCondition = timData.condition ?? 'ungraded';
        }
        else {
            processNewProduct.__lastTimCondition = null;
        }
    }
    catch (err) {
        // TIM lookup is optional — continue without it
        logError(`[AutoList] TIM lookup failed (non-fatal): ${err}`);
        processNewProduct.__lastTimCondition = 'error';
    }
    // Run description and category generation in parallel
    const [descriptionResult, categoryResult] = await Promise.all([
        generateDescription(openai, title, vendor, productNotes, timConditionText),
        suggestCategory(openai, title, vendor),
    ]);
    const ready = descriptionResult.length > 0 && categoryResult.length > 0;
    return {
        description: descriptionResult,
        ebayCategory: categoryResult,
        ready,
    };
}
const DEFAULT_DESCRIPTION_PROMPT = `You are a senior product writer for a professional camera store. Write authoritative, informative product descriptions for pre-owned camera equipment. Your tone is knowledgeable and confident — like a trusted camera store employee explaining gear to a serious photographer.

Format your output EXACTLY as follows:

{Product Name} (#serial if provided) USED — [Descriptive subtitle, NO exclamation marks, factual not hype]

[2-3 sentences. Describe what the product IS and what it does well. Mention the mount system, who it's designed for, and real-world use cases like wildlife, sports, portrait, etc. Be specific about its strengths. Do NOT use phrases like "capture like never before" or "elevate your photography game".]

Key Features
[Plain dash bullets, no emoji. List 4-6 real specs:]
- Exact mount type (Canon EF, Sony E, Nikon Z, etc.)
- Focal length and aperture
- Key technologies (stabilization, autofocus motor type, weather sealing)
- Compatible camera bodies or systems
- Sensor size compatibility (full-frame, APS-C, etc.)

Condition: {Grade}
[1-2 sentences describing ONLY the cosmetic/external condition. Do NOT mention optics, glass, sensor, or internal components — we test those separately. Use this exact scale from Pictureline:]
{CONDITION_SCALE}
[Match the description to the grade. Do NOT speculate about optics, internal condition, or functionality beyond what the grade implies.]

Who Is It For?
[1-2 sentences. Name a specific photographer type and shooting scenario.]

Includes:
[List ONLY items explicitly provided. Use plain text, one per line. NEVER guess or add "if available" items.]

STRICT RULES:
- NO exclamation marks anywhere in the description
- NO hype phrases: "gem", "must-have", "game-changer", "don't miss", "incredible value", "like never before"
- NO invented accessories or "original packaging (if available)" — only list what you KNOW is included
- NEVER list included accessories — we do not know what is included with this specific used item
- NO calls to action or urgency language
- NO mentioning retail price unless explicitly provided in the input data
- Write like an expert, not a salesperson
- Plain text output, no HTML, no markdown bold
- Do not add section labels like "Title:" or "Intro:" — just write the content directly`;
/** Build a condition scale string from canonical grades, optionally overridden by DB settings. */
async function buildConditionScale() {
    let descriptions = { ...GRADE_DESCRIPTIONS };
    try {
        const db = await getRawDb();
        const row = db
            .prepare(`SELECT value FROM settings WHERE key = 'condition_descriptions'`)
            .get();
        if (row?.value) {
            const custom = JSON.parse(row.value);
            descriptions = { ...descriptions, ...custom };
        }
    }
    catch {
        // DB unavailable or parse error — use defaults
    }
    return Object.entries(descriptions)
        .map(([grade, desc]) => `- ${grade}: ${desc}`)
        .join('\n');
}
async function getDescriptionPrompt() {
    const scale = await buildConditionScale();
    try {
        const db = await getRawDb();
        const row = db
            .prepare(`SELECT value FROM settings WHERE key = 'description_prompt'`)
            .get();
        // Use code default unless a non-empty custom prompt was explicitly saved
        const val = row?.value?.trim();
        if (!val || val.length < 200)
            return DEFAULT_DESCRIPTION_PROMPT.replace('{CONDITION_SCALE}', scale);
        // If DB has the old short prompt, ignore it in favor of the better code default
        if (val.includes('Format: **Title line**') && !val.includes('Format your output as follows'))
            return DEFAULT_DESCRIPTION_PROMPT.replace('{CONDITION_SCALE}', scale);
        return val.replace('{CONDITION_SCALE}', scale);
    }
    catch {
        return DEFAULT_DESCRIPTION_PROMPT.replace('{CONDITION_SCALE}', scale);
    }
}
async function generateDescription(openai, title, vendor, productNotes, timConditionText) {
    try {
        const systemPrompt = await getDescriptionPrompt();
        // Build condition line from TIM data if available
        let conditionLine = 'Used — Excellent Plus (assume unless specified otherwise)';
        if (timConditionText?.trim()) {
            conditionLine = `Used — ${timConditionText.trim()}`;
        }
        let userContent = `Product: ${title}\nBrand: ${vendor}\nCondition: ${conditionLine}\nCategory: Auto-detect from product name\nIncluded accessories: UNKNOWN — do not list any accessories in the description since we do not know what is physically included with this specific item`;
        if (productNotes?.trim()) {
            userContent += `\n\nProduct condition notes (MUST be mentioned in the description): ${productNotes.trim()}`;
        }
        const response = await withRetry(() => openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userContent },
            ],
            max_tokens: 1000,
            temperature: 0.7,
        }), 3, 'AutoList/Description');
        return response.choices[0]?.message?.content?.trim() || '';
    }
    catch (err) {
        logError(`[AutoList] Description generation failed after retries: ${err}`);
        return '';
    }
}
async function suggestCategory(openai, title, vendor) {
    try {
        const response = await withRetry(() => openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                {
                    role: 'user',
                    content: `Given this camera product: ${title} by ${vendor}, what is the most appropriate eBay category ID? Common camera categories: Digital Cameras (31388), Camera Lenses (3323), Camera Flashes (48515), Tripods (30090), Camera Bags (15700), Camcorders (11724), Film Cameras (15230), Camera Drones (179697). Return ONLY the numeric category ID.`,
                },
            ],
            max_tokens: 20,
            temperature: 0,
        }), 3, 'AutoList/Category');
        const raw = response.choices[0]?.message?.content?.trim() || '';
        const match = raw.match(/\d+/);
        return match ? match[0] : '';
    }
    catch (err) {
        logError(`[AutoList] Category suggestion failed after retries: ${err}`);
        return '';
    }
}
// ---------------------------------------------------------------------------
// processProductImages — render each image through PhotoRoom template
// ---------------------------------------------------------------------------
/**
 * Process product images via PhotoRoom template rendering.
 *
 * If PHOTOROOM_API_KEY is not set, falls back to returning the original
 * Shopify image URLs (no processing). Processed images are saved to a local
 * temp directory and their file paths are returned.
 */
export async function processProductImages(shopifyProduct) {
    const images = shopifyProduct.images || [];
    const imageUrls = images
        .map((img) => (img.url || img.src || '').replace(/^http:/, 'https:'))
        .filter((url) => url.length > 0);
    let imageService;
    try {
        imageService = await getImageService();
    }
    catch {
        info('[AutoList] No image service available — skipping image processing, using originals');
        return imageUrls;
    }
    const tmpDir = path.join(os.tmpdir(), 'ebay-sync-images', shopifyProduct.id?.toString() || 'unknown');
    fs.mkdirSync(tmpDir, { recursive: true });
    const processedPaths = [];
    for (let i = 0; i < imageUrls.length; i++) {
        const url = imageUrls[i];
        try {
            info(`[AutoList] Rendering image ${i + 1}/${imageUrls.length} with image service`);
            const buf = await imageService.renderWithTemplate(url);
            const filePath = path.join(tmpDir, `image_${i}.png`);
            fs.writeFileSync(filePath, buf);
            processedPaths.push(filePath);
            info(`[AutoList] Saved processed image → ${filePath}`);
        }
        catch (err) {
            warn(`[AutoList] Image processing failed for image ${i + 1}, using original URL: ${err}`);
            processedPaths.push(url); // fallback to original
        }
    }
    info(`[AutoList] Image processing complete: ${processedPaths.length}/${imageUrls.length}`);
    return processedPaths;
}
// ---------------------------------------------------------------------------
// autoListProduct — full pipeline: fetch → AI process → save overrides
// ---------------------------------------------------------------------------
const PIPELINE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minute max per pipeline run
export async function autoListProduct(shopifyProductId, options = {}) {
    const jobId = await createPipelineJob(shopifyProductId);
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), PIPELINE_TIMEOUT_MS);
    const upsertPipelineStatus = async (updates) => {
        const db = await getRawDb();
        const now = Math.floor(Date.now() / 1000);
        const existing = db
            .prepare(`SELECT * FROM product_pipeline_status WHERE shopify_product_id = ?`)
            .get(shopifyProductId);
        const next = {
            ai_description_generated: updates.aiDescriptionGenerated ?? (existing?.ai_description_generated ?? 0),
            ai_description: updates.aiDescription ?? existing?.ai_description ?? null,
            ai_category_id: updates.aiCategoryId ?? existing?.ai_category_id ?? null,
            images_processed: updates.imagesProcessed ?? (existing?.images_processed ?? 0),
            images_processed_count: updates.imagesProcessedCount ?? existing?.images_processed_count ?? 0,
        };
        if (existing) {
            db.prepare(`UPDATE product_pipeline_status
         SET ai_description_generated = ?, ai_description = ?, ai_category_id = ?,
             images_processed = ?, images_processed_count = ?, updated_at = ?
         WHERE shopify_product_id = ?`).run(next.ai_description_generated ? 1 : 0, next.ai_description, next.ai_category_id, next.images_processed ? 1 : 0, next.images_processed_count ?? 0, now, shopifyProductId);
        }
        else {
            db.prepare(`INSERT INTO product_pipeline_status
         (shopify_product_id, ai_description_generated, ai_description, ai_category_id,
          images_processed, images_processed_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(shopifyProductId, next.ai_description_generated ? 1 : 0, next.ai_description, next.ai_category_id, next.images_processed ? 1 : 0, next.images_processed_count ?? 0, now, now);
        }
    };
    try {
        info(`[AutoList] Processing product ${shopifyProductId} (job ${jobId})...`);
        await startPipelineJob(jobId);
        // ── Step 1: Fetch product ──────────────────────────────────────────
        await updatePipelineStep(jobId, 'fetch_product', 'running');
        const db = await getRawDb();
        const tokenRow = db
            .prepare(`SELECT access_token FROM auth_tokens WHERE platform = 'shopify'`)
            .get();
        if (!tokenRow?.access_token) {
            await updatePipelineStep(jobId, 'fetch_product', 'error', 'Shopify token not found');
            return { success: false, jobId, error: 'Shopify token not found' };
        }
        const product = await fetchDetailedShopifyProduct(tokenRow.access_token, shopifyProductId);
        if (!product) {
            await updatePipelineStep(jobId, 'fetch_product', 'error', 'Product not found in Shopify');
            return { success: false, jobId, error: `Product ${shopifyProductId} not found in Shopify` };
        }
        await setPipelineJobTitle(jobId, product.title || shopifyProductId);
        await updatePipelineStep(jobId, 'fetch_product', 'done', `Fetched: ${product.title || shopifyProductId}`);
        // ── Step 2: TIM Condition lookup ────────────────────────────────
        await updatePipelineStep(jobId, 'tim_condition', 'running');
        let timCondition;
        try {
            const { findTimItemForProduct } = await import('../services/tim-matching.js');
            const { applyConditionTag } = await import('../services/tim-tagging.js');
            const skus = (product.variants ?? []).map((v) => v.sku).filter(Boolean);
            const timData = await findTimItemForProduct(skus);
            if (timData?.condition) {
                timCondition = timData.condition;
                const tagResult = await applyConditionTag(tokenRow.access_token, shopifyProductId, timData.condition);
                if (tagResult.success && !tagResult.skipped) {
                    info(`[AutoList] Applied condition tag: ${tagResult.newTag} to product ${shopifyProductId}`);
                }
                await updatePipelineStep(jobId, 'tim_condition', 'done', `Condition: ${timData.condition}`);
            }
            else {
                await updatePipelineStep(jobId, 'tim_condition', 'done', 'No TIM record found');
            }
        }
        catch (err) {
            logError(`[AutoList] TIM tagging failed (non-fatal): ${err}`);
            await updatePipelineStep(jobId, 'tim_condition', 'done', 'TIM lookup failed (non-fatal)');
        }
        // ── Step 3: Search drive for product photos ─────────────────────
        await updatePipelineStep(jobId, 'drive_search', 'running');
        let driveImages = [];
        let drivePresetName = null;
        try {
            const { searchDriveForProduct, isDriveMounted, getSignedUrls } = await import('../watcher/drive-search.js');
            if (isDriveMounted()) {
                const sku = product.variants?.[0]?.sku ?? '';
                const skuSuffix = sku.match(/(\d{2,4})$/)?.[1] ?? null;
                const driveResult = await searchDriveForProduct(product.title || '', skuSuffix);
                if (driveResult) {
                    driveImages = await getSignedUrls(driveResult.imagePaths);
                    drivePresetName = driveResult.presetName;
                    info(`[AutoList] Found ${driveImages.length} photos on drive: ${driveResult.presetName}/${driveResult.folderName}`);
                    await updatePipelineStep(jobId, 'drive_search', 'done', `Found ${driveImages.length} photos in ${driveResult.presetName}/${driveResult.folderName}`);
                }
                else {
                    info(`[AutoList] No drive photos found for "${product.title}"`);
                    await updatePipelineStep(jobId, 'drive_search', 'done', 'No drive photos found');
                }
            }
            else {
                await updatePipelineStep(jobId, 'drive_search', 'done', 'Drive not mounted');
            }
        }
        catch (driveErr) {
            warn(`[AutoList] Drive search failed (non-fatal): ${driveErr}`);
            await updatePipelineStep(jobId, 'drive_search', 'done', 'Drive search failed (non-fatal)');
        }
        // ── Step 4: Generate description + category ────────────────────────
        await updatePipelineStep(jobId, 'generate_description', 'running');
        let description = '';
        let ebayCategory = '';
        // When re-running because photos arrived, reuse the description that was
        // already generated instead of paying for (and waiting on) OpenAI again.
        if (options.reuseExistingDescription) {
            const statusRow = db
                .prepare(`SELECT ai_description, ai_category_id FROM product_pipeline_status WHERE shopify_product_id = ? AND ai_description_generated = 1`)
                .get(shopifyProductId);
            if (statusRow?.ai_description) {
                description = statusRow.ai_description;
                ebayCategory = statusRow.ai_category_id ?? '';
                info(`[AutoList] Reusing existing AI description for ${shopifyProductId} (${description.length} chars)`);
                await updatePipelineStep(jobId, 'generate_description', 'done', `Reused existing description (${description.length} chars)`);
            }
        }
        if (!description) {
            emitProgress(jobId, 'generate_description', 0, 2, 'Looking up TIM condition...');
            const result = await processNewProduct(product);
            // Emit TIM condition visibility
            const lastTimCond = processNewProduct.__lastTimCondition;
            if (lastTimCond && lastTimCond !== 'error') {
                emitProgress(jobId, 'generate_description', 1, 2, `Found condition: ${lastTimCond} (from TIM)`);
            }
            else {
                emitProgress(jobId, 'generate_description', 1, 2, 'TIM condition: not available');
            }
            if (!result.ready) {
                warn(`[AutoList] AI processing incomplete for product ${shopifyProductId}`);
                await updatePipelineStep(jobId, 'generate_description', 'error', 'Incomplete AI results');
                return {
                    success: false,
                    jobId,
                    description: result.description || undefined,
                    categoryId: result.ebayCategory || undefined,
                    error: 'AI processing did not return complete results',
                };
            }
            description = result.description;
            ebayCategory = result.ebayCategory;
            const descPreview = description.substring(0, 100) + (description.length > 100 ? '...' : '');
            await updatePipelineStep(jobId, 'generate_description', 'done', `${description.length} chars — "${descPreview}"`);
            await upsertPipelineStatus({
                aiDescriptionGenerated: true,
                aiDescription: description,
                aiCategoryId: ebayCategory,
            });
        }
        // ── Step 5: Process images via PhotoRoom ───────────────────────────
        await updatePipelineStep(jobId, 'process_images', 'running');
        let processedImages = [];
        try {
            if (driveImages.length > 0) {
                // Process drive photos through PhotoRoom (bg removal + template)
                const { uploadProcessedImage } = await import('../watcher/drive-search.js');
                // Use the saved photo template for this StyleShoots preset when one
                // exists; otherwise fall back to the standard defaults.
                let imageParams = { minPadding: 400, shadow: true, canvasSize: 4000 };
                if (drivePresetName) {
                    try {
                        const { getDefaultForCategory } = await import('../services/photo-templates.js');
                        const template = await getDefaultForCategory(drivePresetName);
                        if (template) {
                            const params = template.params;
                            const canvasSize = typeof params.canvasSize === 'number' ? params.canvasSize : 4000;
                            const minPadding = typeof params.minPadding === 'number'
                                ? params.minPadding
                                : Math.round((typeof params.padding === 'number' ? params.padding : 0.1) * canvasSize);
                            imageParams = { minPadding, shadow: params.shadow ?? true, canvasSize };
                            info(`[AutoList] Using saved template "${template.name}" for preset "${drivePresetName}": ${JSON.stringify(imageParams)}`);
                        }
                    }
                    catch (tplErr) {
                        warn(`[AutoList] Template lookup failed (non-fatal), using defaults: ${tplErr}`);
                    }
                }
                try {
                    const imageService = await getImageService();
                    for (let i = 0; i < driveImages.length; i++) {
                        const MAX_RETRIES = 3;
                        let processed = false;
                        for (let attempt = 1; attempt <= MAX_RETRIES && !processed; attempt++) {
                            try {
                                const attemptLabel = attempt > 1 ? ` (retry ${attempt}/${MAX_RETRIES})` : '';
                                emitProgress(jobId, 'process_images', i + 1, driveImages.length, `Processing photo ${i + 1}/${driveImages.length}${attemptLabel}...`);
                                info(`[AutoList] Processing drive photo ${i + 1}/${driveImages.length}${attemptLabel}: ${driveImages[i].substring(0, 80)}`);
                                const result = await imageService.processWithUniformPadding(driveImages[i], imageParams);
                                const buf = result.buffer;
                                info(`[AutoList] PhotoRoom returned ${buf.length} bytes for image ${i + 1}`);
                                // Save clean version (no watermarks) for photo editor
                                if (result.cleanBuffer) {
                                    await uploadProcessedImage(result.cleanBuffer, `${shopifyProductId}_${i}_clean.png`).catch(() => { });
                                }
                                // Save raw cutout (transparent bg, no shadow) for rotation editor
                                if (result.cutoutBuffer) {
                                    await uploadProcessedImage(result.cutoutBuffer, `${shopifyProductId}_${i}_cutout.png`).catch(() => { });
                                }
                                const url = await uploadProcessedImage(buf, `${shopifyProductId}_${i}.png`);
                                info(`[AutoList] Uploaded processed image ${i + 1}: ${url.substring(0, 80)}`);
                                processedImages.push(url);
                                processed = true;
                            }
                            catch (imgErr) {
                                warn(`[AutoList] PhotoRoom attempt ${attempt}/${MAX_RETRIES} failed for image ${i + 1}: ${imgErr}`);
                                if (attempt < MAX_RETRIES) {
                                    // Wait before retry: 2s, 4s
                                    await new Promise(r => setTimeout(r, attempt * 2000));
                                }
                                else {
                                    warn(`[AutoList] All ${MAX_RETRIES} attempts failed for image ${i + 1}, using original`);
                                    processedImages.push(driveImages[i]);
                                }
                            }
                        }
                    }
                    info(`[AutoList] Processed ${processedImages.length} drive photos through image service`);
                    info(`[AutoList] First processed URL: ${processedImages[0]?.substring(0, 100)}`);
                }
                catch {
                    info(`[AutoList] No image service available — using raw drive photos`);
                    processedImages = driveImages;
                }
            }
            else {
                processedImages = await processProductImages(product);
            }
            await updatePipelineStep(jobId, 'process_images', 'done', `${processedImages.length} images ${driveImages.length > 0 ? 'from drive' : 'processed'}`);
            await upsertPipelineStatus({
                imagesProcessed: processedImages.length > 0,
                imagesProcessedCount: processedImages.length,
            });
        }
        catch (imgErr) {
            warn(`[AutoList] Image processing error (non-fatal): ${imgErr}`);
            await updatePipelineStep(jobId, 'process_images', 'error', String(imgErr));
            // Non-fatal — continue without processed images
        }
        // ── Step 4: Save to draft system (NEVER overwrite live Shopify data) ──
        await updatePipelineStep(jobId, 'create_ebay_listing', 'running');
        // Save overrides for eBay listing use
        await saveProductOverride(shopifyProductId, 'listing', 'description', description);
        await saveProductOverride(shopifyProductId, 'listing', 'primary_category', ebayCategory);
        // Check what the product currently has on Shopify
        const existingContent = await checkExistingContent(shopifyProductId);
        // Build tags list — include product tags plus any newly applied condition tag
        const draftTags = [...(product.tags || [])];
        if (timCondition) {
            const condTag = `condition:${timCondition}`;
            if (!draftTags.some(t => t.toLowerCase() === condTag.toLowerCase())) {
                draftTags.push(condTag);
            }
        }
        // Create a draft with processed content + original content for comparison
        const draftId = await createDraft(shopifyProductId, {
            title: product.title || '',
            description,
            // Only pass images if we actually have processed ones — otherwise let COALESCE
            // preserve any images saved by an earlier step (e.g. the trigger endpoint's raw drive photos)
            images: processedImages.length > 0 ? processedImages : undefined,
            originalTitle: existingContent.title,
            originalDescription: existingContent.description,
            originalImages: existingContent.images,
            tags: draftTags.length > 0 ? draftTags : undefined,
        });
        // Auto-publish logic:
        // If product has NO existing content AND auto-publish is enabled → publish directly
        // If product HAS existing content → always save as draft, never overwrite
        // If requireReview is set (low-confidence photo match) → always save as draft
        const productType = product.productType || 'default';
        const autoPublishEnabled = await getAutoPublishSetting(productType);
        const hasExistingContent = existingContent.hasPhotos || existingContent.hasDescription;
        if (!hasExistingContent && autoPublishEnabled && !options.requireReview) {
            info(`[AutoList] Product ${shopifyProductId} has no existing content and auto-publish is ON — publishing directly`);
            const approveResult = await approveDraft(draftId, { photos: true, description: true });
            if (approveResult.success) {
                await updatePipelineStep(jobId, 'create_ebay_listing', 'done', 'Auto-published (no existing content)');
            }
            else {
                await updatePipelineStep(jobId, 'create_ebay_listing', 'done', `Draft created (#${draftId}) — auto-publish failed: ${approveResult.error}`);
            }
        }
        else {
            const reason = options.requireReview
                ? 'low-confidence photo match — requires manual review'
                : hasExistingContent
                    ? 'product has existing content — requires manual review'
                    : 'auto-publish disabled for this product type';
            await updatePipelineStep(jobId, 'create_ebay_listing', 'done', `Draft created (#${draftId}) — ${reason}`);
            info(`[AutoList] Draft #${draftId} saved for review — ${reason}`);
        }
        info(`[AutoList] ✅ Product ${shopifyProductId} processed (job ${jobId}) — category=${ebayCategory}, description=${description.length} chars, images=${processedImages.length}, draft=#${draftId}`);
        clearTimeout(timeoutId);
        return {
            success: true,
            jobId,
            description,
            categoryId: ebayCategory,
            images: processedImages,
        };
    }
    catch (err) {
        clearTimeout(timeoutId);
        const isTimeout = err instanceof Error && err.name === 'AbortError';
        const errorMsg = isTimeout
            ? `Pipeline timed out after ${PIPELINE_TIMEOUT_MS / 1000}s`
            : (err instanceof Error ? err.message : String(err));
        logError(`[AutoList] Failed for product ${shopifyProductId} (job ${jobId}): ${errorMsg}`);
        await updatePipelineStep(jobId, 'process_images', 'error', errorMsg).catch(() => { });
        return { success: false, jobId, error: errorMsg };
    }
}
