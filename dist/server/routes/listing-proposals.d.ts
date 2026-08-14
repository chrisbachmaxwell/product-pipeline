import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { type ListingProposalService } from '../listing-proposal-service.js';
declare function allowProposalAttempt(subject: string, now?: number): boolean;
export declare function createListingProposalRouter(service?: ListingProposalService): Router;
export declare const listingProposalJsonParser: import("connect").NextHandleFunction;
export declare function listingProposalJsonErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void;
declare const _default: express.Router;
export default _default;
export declare const LISTING_PROPOSAL_ROUTE_TESTING: Readonly<{
    allowProposalAttempt: typeof allowProposalAttempt;
    maximumBuckets: 2000;
    rateBucketCount(): number;
    resetRates(): void;
}>;
