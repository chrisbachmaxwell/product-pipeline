import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { type ListingDraftService } from '../listing-draft-service.js';
declare function allowDraftAttempt(subject: string, now?: number): boolean;
export declare function createListingDraftRouter(service?: ListingDraftService): Router;
export declare const listingDraftJsonParser: import("connect").NextHandleFunction;
export declare function listingDraftJsonErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void;
declare const _default: express.Router;
export default _default;
export declare const LISTING_DRAFT_ROUTE_TESTING: Readonly<{
    allowDraftAttempt: typeof allowDraftAttempt;
    maximumBuckets: 2000;
    rateBucketCount(): number;
    resetWriteRates(): void;
}>;
