import { Router } from 'express';
import { type EbayCategoryAspectsDto } from '../ebay-category-aspects.js';
export type EbayCategoryAspectsRouteDependencies = {
    readAspects?: (categoryId: string) => Promise<EbayCategoryAspectsDto>;
};
/**
 * GET /api/ebay-category-aspects?id=<categoryId> — the category's item
 * specifics (required first) for the listing editor. Read-only, cached,
 * degrades to `available:false` instead of erroring.
 */
export declare function createEbayCategoryAspectsRouter(dependencies?: EbayCategoryAspectsRouteDependencies): Router;
declare const _default: Router;
export default _default;
