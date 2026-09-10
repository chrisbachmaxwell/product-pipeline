import { Router } from 'express';
import { readActivityFeed } from '../activity-feed.js';
function parseQueryInteger(value) {
    if (typeof value !== 'string' || !/^\d{1,4}$/.test(value))
        return undefined;
    return Number.parseInt(value, 10);
}
/**
 * GET /api/activity — read-only operator activity feed. Request-time only:
 * one bounded read of the configured migration store, zero provider calls,
 * zero writes. A missing or unreadable store degrades to
 * `{ available: false, events: [] }` — never a 500 — so the operator UI can
 * always render.
 */
export function createActivityHandler(dependencies = {}) {
    const readFeed = dependencies.readFeed ?? readActivityFeed;
    return async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        const generatedAtUtc = new Date().toISOString();
        try {
            const feed = await readFeed({
                limit: parseQueryInteger(req.query?.limit),
                windowHours: parseQueryInteger(req.query?.windowHours),
            });
            res.json({
                schemaVersion: 1,
                available: feed.available,
                windowHours: feed.windowHours,
                generatedAtUtc,
                externalWritesPerformed: 0,
                events: feed.events,
            });
        }
        catch {
            res.json({
                schemaVersion: 1,
                available: false,
                windowHours: 0,
                generatedAtUtc,
                externalWritesPerformed: 0,
                events: [],
            });
        }
    };
}
export function createActivityRouter(dependencies = {}) {
    const router = Router();
    router.get('/api/activity', createActivityHandler(dependencies));
    return router;
}
const activityRoutes = createActivityRouter();
export default activityRoutes;
