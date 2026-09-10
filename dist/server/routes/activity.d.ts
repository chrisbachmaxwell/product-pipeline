import { Router, type Request, type Response } from 'express';
import { readActivityFeed } from '../activity-feed.js';
export type ActivityRouteDependencies = {
    readFeed?: typeof readActivityFeed;
};
/**
 * GET /api/activity — read-only operator activity feed. Request-time only:
 * one bounded read of the configured migration store, zero provider calls,
 * zero writes. A missing or unreadable store degrades to
 * `{ available: false, events: [] }` — never a 500 — so the operator UI can
 * always render.
 */
export declare function createActivityHandler(dependencies?: ActivityRouteDependencies): (req: Request, res: Response) => Promise<void>;
export declare function createActivityRouter(dependencies?: ActivityRouteDependencies): Router;
declare const activityRoutes: Router;
export default activityRoutes;
