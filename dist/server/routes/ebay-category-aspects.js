import { Router } from 'express';
import { getEbayCategoryAspects, } from '../ebay-category-aspects.js';
/**
 * GET /api/ebay-category-aspects?id=<categoryId> — the category's item
 * specifics (required first) for the listing editor. Read-only, cached,
 * degrades to `available:false` instead of erroring.
 */
export function createEbayCategoryAspectsRouter(dependencies = {}) {
    const readAspects = dependencies.readAspects ?? getEbayCategoryAspects;
    const router = Router();
    router.get('/api/ebay-category-aspects', async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        const id = typeof req.query.id === 'string' ? req.query.id.trim() : '';
        res.json(await readAspects(id));
    });
    return router;
}
export default createEbayCategoryAspectsRouter();
