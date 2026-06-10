import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDb, getRawDb } from '../db/client.js';
import { info, error as logError } from '../utils/logger.js';
// Route imports
import healthRoutes from './routes/health.js';
import apiRoutes from './routes/api.js';
import ebayNotificationRoutes from './routes/ebay-notifications.js';
import shopifyWebhookRoutes from './routes/shopify-webhooks.js';
import shopifyAuthRoutes from './routes/shopify-auth.js';
import ebayAuthRoutes from './routes/ebay-auth.js';
import chatRoutes from './routes/chat.js';
import pipelineRoutes from './routes/pipeline.js';
import helpRoutes from './routes/help.js';
import featureRoutes from './routes/features.js';
import watcherRoutes from './routes/watcher.js';
import imageRoutes from './routes/images.js';
import templateRoutes from './routes/templates.js';
import draftRoutes from './routes/drafts.js';
import photoEditRoutes from './routes/photo-edit.js';
import ebayOrderRoutes from './routes/ebay-orders.js';
import ebayMetadataRoutes from './routes/ebay-metadata.js';
import timRoutes from './routes/tim.js';
import { apiKeyAuth, rateLimit } from './middleware/auth.js';
import { testModeMiddleware, testModeRoute, isTestMode } from './middleware/test-mode.js';
import { getCapabilities, getNewCapabilities } from './capabilities.js';
import { initPhotoTemplatesTable } from '../services/photo-templates.js';
import { seedHelpArticles } from './seeds/help-articles.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
// --- Middleware ---
// CORS configuration - restrictive for security
app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin)
            return callback(null, true);
        const allowedOrigins = [
            'https://admin.shopify.com',
            'https://usedcameragear.myshopify.com',
            'https://ebay-sync-app-production.up.railway.app', // Legacy domain
        ];
        // Our own deployed domain(s) from environment
        if (process.env.APP_URL) {
            allowedOrigins.push(process.env.APP_URL.replace(/\/$/, ''));
        }
        if (process.env.RAILWAY_PUBLIC_DOMAIN) {
            allowedOrigins.push(`https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
        }
        // Allow Shopify domains
        if (origin.match(/\.shopify\.com$/)) {
            return callback(null, true);
        }
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        // In TEST_MODE, allow localhost origins
        if (isTestMode() && (origin.includes('localhost') || origin.includes('127.0.0.1'))) {
            return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
}));
// Raw body for webhook HMAC verification (must come before json parser)
app.use('/webhooks/shopify', express.raw({ type: 'application/json' }), (req, _res, next) => {
    req.rawBody = req.body;
    if (Buffer.isBuffer(req.body)) {
        req.body = JSON.parse(req.body.toString('utf8'));
    }
    next();
});
// Raw body for eBay XML notifications
app.use('/webhooks/ebay', express.text({ type: ['text/xml', 'application/xml', 'application/soap+xml'] }));
// JSON for everything else
app.use(express.json({ limit: '50mb' }));
// --- Test Mode ---
app.use(testModeMiddleware);
app.get('/api/test-mode', testModeRoute);
// --- Security Middleware ---
app.use(rateLimit);
// In TEST_MODE, skip API key auth so browser tests can hit routes directly
if (!isTestMode()) {
    app.use('/api', apiKeyAuth);
}
// --- Routes ---
app.use(healthRoutes);
app.use(apiRoutes);
app.use(ebayNotificationRoutes);
app.use(shopifyWebhookRoutes);
app.use(shopifyAuthRoutes);
app.use(ebayAuthRoutes);
app.use(chatRoutes);
app.use(pipelineRoutes);
app.use(helpRoutes);
app.use(featureRoutes);
app.use(watcherRoutes);
app.use(imageRoutes);
app.use(templateRoutes);
app.use(draftRoutes);
app.use(photoEditRoutes);
app.use(ebayOrderRoutes);
app.use(ebayMetadataRoutes);
app.use(timRoutes);
// --- Capabilities discovery endpoint ---
app.get('/api/capabilities', (_req, res) => {
    res.json({
        capabilities: getCapabilities(),
        newCapabilities: getNewCapabilities(),
    });
});
// Serve static frontend (built Vite app)
const webDistPath = path.join(__dirname, '..', '..', 'dist', 'web');
app.use(express.static(webDistPath));
// Global error handler - prevent stack trace exposure
app.use((err, req, res, next) => {
    logError(`[Server] Unhandled error: ${err.message}`);
    // Don't expose stack traces in production
    const isProduction = process.env.NODE_ENV === 'production';
    res.status(err.status || 500).json({
        error: isProduction ? 'Internal server error' : err.message,
        ...(isProduction ? {} : { stack: err.stack }),
    });
});
// SPA fallback — serve index.html for any non-API route
// Express 5 uses named catch-all params: {*path}
app.get('/{*path}', (req, res) => {
    // Don't serve HTML for API/webhook routes
    if (req.path.startsWith('/api') || req.path.startsWith('/webhooks') || req.path.startsWith('/auth') || req.path.startsWith('/ebay/auth') || req.path === '/health') {
        res.status(404).json({ error: 'Not found' });
        return;
    }
    // In TEST_MODE, serve index.html without Shopify App Bridge (which causes auth redirects)
    if (isTestMode()) {
        const indexPath = path.join(webDistPath, 'index.html');
        try {
            let html = fs.readFileSync(indexPath, 'utf8');
            html = html.replace(/<meta name="shopify-api-key"[^>]*>/, '');
            html = html.replace(/<script src="https:\/\/cdn\.shopify\.com\/shopifycloud\/app-bridge\.js"><\/script>/, '');
            res.type('html').send(html);
            return;
        }
        catch (err) {
            // Fall through to normal handler
        }
    }
    res.sendFile(path.join(webDistPath, 'index.html'), (err) => {
        if (err) {
            res.status(200).json({
                app: 'ProductPipeline',
                version: '0.2.0',
                message: 'Frontend not built yet. Run: npm run build:web',
                endpoints: {
                    health: '/health',
                    api: '/api/status',
                },
            });
        }
    });
});
// --- Initialize and Start ---
async function start() {
    try {
        // Initialize database (creates tables if needed)
        await getDb();
        const rawDb = await getRawDb();
        info('[Server] Database initialized');
        // Ensure new tables exist
        initExtraTables(rawDb);
        // Phase 3: Initialize photo templates table
        await initPhotoTemplatesTable();
        // Seed default settings
        seedDefaultSettings(rawDb);
        // Seed help articles (idempotent — skips existing articles)
        seedHelpArticles(rawDb);
        // Seed default field mappings
        // seedDefaultMappings handled by db/client.ts using attribute_mappings table
        app.listen(PORT, () => {
            info(`[Server] ProductPipeline running on http://localhost:${PORT}`);
            info(`[Server] Health: http://localhost:${PORT}/health`);
            info(`[Server] API: http://localhost:${PORT}/api/status`);
        });
        // Start background sync scheduler
        startSyncScheduler(rawDb);
        // Start the GCS photo-arrival watcher (no-op unless DRIVE_MODE=cloud)
        const { startCloudWatcher } = await import('../watcher/cloud-watcher.js');
        await startCloudWatcher();
    }
    catch (err) {
        logError(`[Server] Failed to start: ${err}`);
        process.exit(1);
    }
}
/**
 * Create extra tables for the web app (notification_log, settings)
 */
function initExtraTables(db) {
    db.exec(`
    CREATE TABLE IF NOT EXISTS notification_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      topic TEXT NOT NULL,
      payload TEXT NOT NULL,
      processedAt TEXT,
      status TEXT DEFAULT 'received',
      error TEXT,
      createdAt TEXT DEFAULT (datetime('now'))
    )
  `);
    db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updatedAt TEXT DEFAULT (datetime('now'))
    )
  `);
    db.exec(`
    CREATE TABLE IF NOT EXISTS field_mappings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mapping_type TEXT NOT NULL,
      source_value TEXT,
      target_value TEXT NOT NULL,
      is_default BOOLEAN DEFAULT FALSE,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
    info('[Server] Extra tables initialized');
}
/**
 * Seed default settings if they don't exist
 */
function seedDefaultSettings(db) {
    const defaults = {
        sync_price: 'true',
        sync_inventory: 'true',
        auto_list: 'false',
        sync_interval_minutes: '5',
        auto_sync_enabled: 'false', // MUST be explicitly enabled
        // eBay order import go-live cutoff (ISO timestamp). Empty = live order
        // import refuses to run. Set when switching off Marketplace Connect.
        ebay_order_import_cutoff: '',
        // GCS photo-arrival watcher (only active when DRIVE_MODE=cloud)
        cloud_watcher_enabled: 'true',
        item_location: '305 W 700 S, Salt Lake City, UT 84101',
        // AI Listing Management
        listing_management_enabled: 'false', // MUST be explicitly enabled
        republish_max_age_days: '30',
        price_drop_after_days: '14',
        price_drop_percent: '10',
    };
    const stmt = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
    for (const [key, value] of Object.entries(defaults)) {
        stmt.run(key, value);
    }
}
/**
 * Seed default field mappings if they don't exist
 */
function seedDefaultMappings(db) {
    const checkExisting = db.prepare(`SELECT COUNT(*) as count FROM field_mappings`).get();
    if (checkExisting?.count > 0) {
        return; // Already seeded
    }
    const stmt = db.prepare(`
    INSERT INTO field_mappings (mapping_type, source_value, target_value, is_default) 
    VALUES (?, ?, ?, ?)
  `);
    // Condition mappings
    const conditionMappings = [
        ['condition', 'New', 'NEW', false],
        ['condition', 'Like New', 'LIKE_NEW', false],
        ['condition', 'Mint', 'LIKE_NEW', false],
        ['condition', 'Excellent', 'VERY_GOOD', false],
        ['condition', 'Good', 'GOOD', false],
        ['condition', 'Fair', 'ACCEPTABLE', false],
        ['condition', 'Acceptable', 'ACCEPTABLE', false],
        ['condition', 'For Parts', 'FOR_PARTS_OR_NOT_WORKING', false],
        ['condition', null, 'GOOD', true], // Default condition
    ];
    // Field mappings
    const fieldMappings = [
        ['field', 'title', 'Title', false],
        ['field', 'body_html', 'Description', false],
        ['field', 'vendor', 'Brand', false],
        ['field', 'images[0]', 'GalleryURL', false],
    ];
    // Category mappings (from existing mapper.ts)
    const categoryMappings = [
        ['category', 'Camera', '31388', false],
        ['category', 'Cameras', '31388', false],
        ['category', 'Mirrorless', '31388', false],
        ['category', 'DSLR', '31388', false],
        ['category', 'Lens', '3323', false],
        ['category', 'Lenses', '3323', false],
        ['category', 'Flash', '48515', false],
        ['category', 'Strobe', '48515', false],
        ['category', 'Light', '183331', false],
        ['category', 'LED', '183331', false],
        ['category', 'Tripod', '30090', false],
        ['category', 'Monopod', '30090', false],
        ['category', 'Gimbal', '183329', false],
        ['category', 'Stabilizer', '183329', false],
        ['category', 'Head', '30090', false],
        ['category', 'Bag', '16031', false],
        ['category', 'Case', '16031', false],
        ['category', 'Backpack', '16031', false],
        ['category', 'Filter', '48518', false],
        ['category', 'Memory', '96991', false],
        ['category', 'Card', '96991', false],
        ['category', 'SD', '96991', false],
        ['category', 'Battery', '48511', false],
        ['category', 'Charger', '48511', false],
        ['category', 'Video', '29996', false],
        ['category', 'Cinema', '29996', false],
        ['category', 'Monitor', '29996', false],
        ['category', 'Cable', '182094', false],
        ['category', 'Adapter', '182094', false],
        ['category', 'Converter', '182094', false],
        ['category', null, '48519', true], // Default: Other Camera Accessories
    ];
    // Inventory location mapping
    const inventoryMappings = [
        ['inventory_location', 'default', 'all', true],
    ];
    // Insert all mappings
    const allMappings = [
        ...conditionMappings,
        ...fieldMappings,
        ...categoryMappings,
        ...inventoryMappings,
    ];
    for (const mapping of allMappings) {
        stmt.run(...mapping);
    }
    info('[Server] Seeded default field mappings');
}
/**
 * Background sync scheduler — fallback polling every N minutes
 */
function startSyncScheduler(db) {
    const checkInterval = setInterval(async () => {
        try {
            // Read setting from DB (don't cache it)
            const setting = db.prepare(`SELECT value FROM settings WHERE key = 'auto_sync_enabled'`).get();
            const autoSyncEnabled = setting?.value === 'true';
            if (!autoSyncEnabled) {
                return; // Auto-sync disabled, skip silently
            }
            const intervalSetting = db.prepare(`SELECT value FROM settings WHERE key = 'sync_interval_minutes'`).get();
            const intervalMinutes = parseInt(intervalSetting?.value || '5', 10);
            info(`[Scheduler] Running auto-sync (interval: ${intervalMinutes} minutes)`);
            await runBackgroundSync();
        }
        catch (err) {
            logError(`[Scheduler] Auto-sync check error: ${err}`);
        }
    }, 60000); // Check every minute
    info('[Scheduler] Auto-sync scheduler started. Enable with setting auto_sync_enabled=true');
    // Clean up on process exit
    process.on('SIGTERM', () => clearInterval(checkInterval));
    process.on('SIGINT', () => clearInterval(checkInterval));
}
async function runBackgroundSync() {
    try {
        const { runOrderSync } = await import('./sync-helper.js');
        // Only sync orders from the last 24 hours for auto-sync
        const result = await runOrderSync({ confirm: true });
        if (result) {
            info(`[Scheduler] Background sync complete: ${result.imported} imported, ${result.skipped} skipped, ${result.failed} failed`);
        }
        else {
            info(`[Scheduler] Background sync skipped (no tokens configured)`);
        }
    }
    catch (err) {
        logError(`[Scheduler] Background sync error: ${err}`);
    }
    // Run AI listing management (republish stale, price drops)
    try {
        const { getValidEbayToken } = await import('../ebay/token-manager.js');
        const ebayToken = await getValidEbayToken();
        if (ebayToken) {
            const { runListingManagement } = await import('../sync/listing-manager.js');
            const mgmtResult = await runListingManagement(ebayToken);
            info(`[Scheduler] Listing management: republished=${mgmtResult.republish.republished}, price_drops=${mgmtResult.priceDrop.dropped}`);
        }
    }
    catch (err) {
        logError(`[Scheduler] Listing management error: ${err}`);
    }
}
start();
