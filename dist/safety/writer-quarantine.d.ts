import type { NextFunction, Request, Response } from 'express';
import type { WriterResponsibility } from './responsibilities.js';
/**
 * `listingLifecycle` is retained only as a coarse legacy denial label for
 * already-quarantined services. It is not accepted by ownership, approval,
 * persistence, reconciliation, or canary APIs.
 */
export type QuarantinedResponsibility = WriterResponsibility | 'listingLifecycle' | 'externalCommerce';
export declare const WRITER_QUARANTINE_CODE: "WRITER_QUARANTINED";
export declare const MARKETPLACE_CONNECT_BASELINE: Readonly<{
    policyVersion: 1;
    phase: "marketplace-connect-incumbent";
    effectiveMode: "shadow-read-only";
    externalWritesAllowed: false;
    historicalBackfillAllowed: false;
    cutoverWatermarkUtc: null;
    remoteVerification: "not-performed";
    responsibilities: Readonly<{
        orderImport: Readonly<{
            owner: "marketplace-connect";
            productPipelineAccess: "disabled";
            writesAllowed: false;
        }>;
        price: Readonly<{
            owner: "marketplace-connect";
            productPipelineAccess: "read-only";
            writesAllowed: false;
        }>;
        inventory: Readonly<{
            owner: "marketplace-connect";
            productPipelineAccess: "read-only";
            writesAllowed: false;
        }>;
        listingCreate: Readonly<{
            owner: "unverified";
            productPipelineAccess: "read-only";
            writesAllowed: false;
        }>;
        listingRevise: Readonly<{
            owner: "unverified";
            productPipelineAccess: "read-only";
            writesAllowed: false;
        }>;
        listingEndRelist: Readonly<{
            owner: "unverified";
            productPipelineAccess: "read-only";
            writesAllowed: false;
        }>;
        mapping: Readonly<{
            owner: "unverified";
            productPipelineAccess: "read-only";
            writesAllowed: false;
        }>;
        fulfillment: Readonly<{
            owner: "unverified";
            productPipelineAccess: "read-only";
            writesAllowed: false;
        }>;
        feedback: Readonly<{
            owner: "unverified";
            productPipelineAccess: "read-only";
            writesAllowed: false;
        }>;
        reconciliation: Readonly<{
            owner: "unverified";
            productPipelineAccess: "read-only";
            writesAllowed: false;
        }>;
    }>;
    quarantineChannels: readonly ["api", "shopify-webhooks", "ebay-webhooks", "scheduler", "legacy-cli", "authentication-routes", "ebay-adapter", "shopify-order-adapter", "shopify-inventory-adapter"];
}>;
export declare class WriterQuarantinedError extends Error {
    readonly code: "WRITER_QUARANTINED";
    readonly responsibility: QuarantinedResponsibility;
    readonly operation: string;
    readonly incumbentOwner: 'marketplace-connect' | 'unverified';
    constructor(responsibility: QuarantinedResponsibility, operation: string);
    toResponse(): {
        error: string;
        code: "WRITER_QUARANTINED";
        responsibility: QuarantinedResponsibility;
        operation: string;
        incumbentOwner: "marketplace-connect" | "unverified";
        effectiveMode: "shadow-read-only";
        externalWritesAllowed: boolean;
        historicalBackfillAllowed: boolean;
        cutoverWatermarkUtc: null;
        requiredDecision: string;
    };
}
/**
 * The current migration phase has no runtime override. Every call fails before
 * credentials, databases, platform reads, or writes are reached.
 */
export declare function denyExternalWrite(responsibility: QuarantinedResponsibility, operation: string): void;
export declare function responsibilityForApiPath(pathname: string): QuarantinedResponsibility;
export declare function isReadOnlyHttpMethod(method: string): boolean;
/** One local-only append exception. It grants no provider or publish authority. */
export declare function isExactLocalDraftAppend(method: string, originalUrl: string): boolean;
/** Default-deny every state-changing API method during shadow mode. */
export declare function writerQuarantineMiddleware(req: Request, res: Response, next: NextFunction): void;
export declare function getMigrationPolicyStatus(servedAt?: string): {
    phase: "marketplace-connect-incumbent";
    effectiveMode: "shadow-read-only";
    externalWritesAllowed: false;
    historicalBackfillAllowed: false;
    cutoverWatermarkUtc: null;
    remoteVerification: "not-performed";
    servedAt: string;
    responsibilities: ({
        owner: "marketplace-connect";
        productPipelineAccess: "disabled";
        writesAllowed: false;
        responsibility: string;
    } | {
        owner: "marketplace-connect";
        productPipelineAccess: "read-only";
        writesAllowed: false;
        responsibility: string;
    } | {
        owner: "marketplace-connect";
        productPipelineAccess: "read-only";
        writesAllowed: false;
        responsibility: string;
    } | {
        owner: "unverified";
        productPipelineAccess: "read-only";
        writesAllowed: false;
        responsibility: string;
    } | {
        owner: "unverified";
        productPipelineAccess: "read-only";
        writesAllowed: false;
        responsibility: string;
    } | {
        owner: "unverified";
        productPipelineAccess: "read-only";
        writesAllowed: false;
        responsibility: string;
    } | {
        owner: "unverified";
        productPipelineAccess: "read-only";
        writesAllowed: false;
        responsibility: string;
    } | {
        owner: "unverified";
        productPipelineAccess: "read-only";
        writesAllowed: false;
        responsibility: string;
    } | {
        owner: "unverified";
        productPipelineAccess: "read-only";
        writesAllowed: false;
        responsibility: string;
    } | {
        owner: "unverified";
        productPipelineAccess: "read-only";
        writesAllowed: false;
        responsibility: string;
    })[];
    quarantine: {
        enabled: true;
        channels: ("api" | "shopify-webhooks" | "ebay-webhooks" | "scheduler" | "legacy-cli" | "authentication-routes" | "ebay-adapter" | "shopify-order-adapter" | "shopify-inventory-adapter")[];
        runtimeOverrideAvailable: false;
    };
};
