import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { info, error as logError } from '../utils/logger.js';
// Route imports
import healthRoutes from './routes/health.js';
import ebayNotificationRoutes from './routes/ebay-notifications.js';
import shopifyWebhookRoutes from './routes/shopify-webhooks.js';
import { inventorySweepTrigger } from './inventory-sweep-trigger.js';
import shadowApiRoutes from './routes/shadow-api.js';
import listingDraftRoutes, { listingDraftJsonErrorHandler, listingDraftJsonParser, } from './routes/listing-drafts.js';
import { apiKeyAuth, rateLimit } from './middleware/auth.js';
import { testModeMiddleware, testModeRoute, isTestMode } from './middleware/test-mode.js';
import { writerQuarantineMiddleware } from '../safety/writer-quarantine.js';
import { startLiveListingCatalogRefresher } from './live-listing-catalog-source.js';
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
// --- Test Mode ---
app.use(testModeMiddleware);
if (isTestMode()) {
    app.get('/api/test-mode', testModeRoute);
}
// --- Security Middleware ---
app.use(rateLimit);
app.use('/api', apiKeyAuth);
// Shadow-mode invariant: every state-changing API request is denied before a
// legacy handler can load credentials, touch the database, or contact a platform.
app.use('/api', writerQuarantineMiddleware);
// Parse the sole local mutation only after authentication and the exact
// quarantine exception. No unauthenticated or quarantined API body is parsed.
app.post('/api/listing-draft', listingDraftJsonParser);
app.use(listingDraftJsonErrorHandler);
// --- Routes ---
app.use(healthRoutes);
app.use(listingDraftRoutes);
app.use(shadowApiRoutes);
app.use(ebayNotificationRoutes);
app.use(shopifyWebhookRoutes);
// No legacy API handler may fall through to the static app or become reachable
// through an accidental route import.
app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API route is not available in shadow mode' });
});
// Serve static frontend (built Vite app)
const webDistPath = path.join(__dirname, '..', '..', 'dist', 'web');
app.use(express.static(webDistPath, { index: false }));
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
                    api: '/api/migration/status',
                },
            });
        }
    });
});
// --- Initialize and Start ---
async function start() {
    try {
        startLiveListingCatalogRefresher();
        app.listen(PORT, () => {
            info(`[Server] ProductPipeline running on http://localhost:${PORT}`);
            info(`[Server] Health: http://localhost:${PORT}/health`);
            info(`[Server] API: http://localhost:${PORT}/api/migration/status`);
        });
        info('[Safety] Shadow read-only mode active; listing reader refreshes in background; commerce scheduler and watcher are not mounted');
        // Periodic FULL inventory alignment. Inert unless the operator has set
        // INVENTORY_FULL_SWEEP_ARGV; nothing dispatches at load, and the first
        // tick only acts if genuinely overdue against the persisted due time.
        // This backstops the Shopify webhook, which cannot see a dropped
        // delivery, eBay ending or relisting on its own, or a Seller Hub edit.
        // No writer is mounted here: it spawns the operator's standalone command.
        inventorySweepTrigger.startFullSweepSchedule();
    }
    catch (err) {
        logError(`[Server] Failed to start: ${err}`);
        process.exit(1);
    }
}
start();
