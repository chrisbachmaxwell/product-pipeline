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
    policyVersion: 2;
    phase: "product-pipeline-steady-state";
    effectiveMode: "shadow-read-only";
    externalWritesAllowed: false;
    historicalBackfillAllowed: false;
    cutoverWatermarkUtc: "2026-09-08T21:50:00.000Z";
    remoteVerification: "not-performed";
    responsibilities: Readonly<{
        orderImport: Readonly<{
            owner: "product-pipeline";
            productPipelineAccess: "ceremony";
            writesAllowed: false;
        }>;
        price: Readonly<{
            owner: "product-pipeline";
            productPipelineAccess: "ceremony";
            writesAllowed: false;
        }>;
        inventory: Readonly<{
            owner: "product-pipeline";
            productPipelineAccess: "ceremony";
            writesAllowed: false;
        }>;
        listingCreate: Readonly<{
            owner: "product-pipeline";
            productPipelineAccess: "ceremony";
            writesAllowed: false;
        }>;
        listingRevise: Readonly<{
            owner: "product-pipeline";
            productPipelineAccess: "ceremony";
            writesAllowed: false;
        }>;
        listingEndRelist: Readonly<{
            owner: "product-pipeline";
            productPipelineAccess: "ceremony";
            writesAllowed: false;
        }>;
        mapping: Readonly<{
            owner: "unverified";
            productPipelineAccess: "read-only";
            writesAllowed: false;
        }>;
        fulfillment: Readonly<{
            owner: "product-pipeline";
            productPipelineAccess: "ceremony";
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
/**
 * The one publish exception. The handler behind it performs no provider
 * write in this process: it spawns the standalone listing-lifecycle-admin
 * ceremonies (preflight-create → dispatch-create), which enforce the exact
 * approved draft revision, idempotent intent, single-use approval, and
 * post-dispatch reconciliation. The operator's authenticated Shopify-session
 * click is the one-action approval; the route additionally requires the
 * exact store session (see routes/listing-publish.ts) and refuses unless the
 * operator has armed PUBLISH_*_ARGV on the server. Added 2026-09-10 when the
 * operator required publishing from the UI.
 */
export declare function isExactListingPublish(method: string, originalUrl: string): boolean;
/**
 * The publish-recovery exception, held to the same bar as publish: the
 * handler spawns only the operator-armed recovery ceremonies (reconcile →
 * recover-create → recover-reconcile) that automatic post-publish cleanup
 * already runs, requires the exact store session, and performs no provider
 * write in this process. It exists so a failed publish whose automatic
 * cleanup also failed can be retried by the operator from the UI instead of
 * requiring an engineer at a terminal. Added 2026-09-16.
 */
export declare function isExactListingRecovery(method: string, originalUrl: string): boolean;
/**
 * The publish-all exception, same bar as publish: the handler only starts
 * the background runner whose every provider write goes through the armed
 * ceremony CLIs per item; the authenticated click is the operator's
 * one-action batch approval (the G18 sweep precedent). Added 2026-09-18
 * when the operator asked for a Publish-All button and schedule.
 */
export declare function isExactListingPublishAll(method: string, originalUrl: string): boolean;
/**
 * The connections exception (L79): Settings stores/removes the operator's
 * pasted AI key in the local credential vault. Local-only writes — the
 * handler performs zero commerce-provider writes; its single outbound call
 * is a read-only key validation against the AI provider.
 */
export declare function isExactConnectionWrite(method: string, originalUrl: string): boolean;
/** Default-deny every state-changing API method during shadow mode. */
export declare function writerQuarantineMiddleware(req: Request, res: Response, next: NextFunction): void;
export declare function getMigrationPolicyStatus(servedAt?: string): {
    phase: "product-pipeline-steady-state";
    effectiveMode: "shadow-read-only";
    externalWritesAllowed: false;
    historicalBackfillAllowed: false;
    cutoverWatermarkUtc: "2026-09-08T21:50:00.000Z";
    remoteVerification: "not-performed";
    servedAt: string;
    responsibilities: ({
        owner: "product-pipeline";
        productPipelineAccess: "ceremony";
        writesAllowed: false;
        responsibility: string;
    } | {
        owner: "product-pipeline";
        productPipelineAccess: "ceremony";
        writesAllowed: false;
        responsibility: string;
    } | {
        owner: "product-pipeline";
        productPipelineAccess: "ceremony";
        writesAllowed: false;
        responsibility: string;
    } | {
        owner: "product-pipeline";
        productPipelineAccess: "ceremony";
        writesAllowed: false;
        responsibility: string;
    } | {
        owner: "product-pipeline";
        productPipelineAccess: "ceremony";
        writesAllowed: false;
        responsibility: string;
    } | {
        owner: "product-pipeline";
        productPipelineAccess: "ceremony";
        writesAllowed: false;
        responsibility: string;
    } | {
        owner: "unverified";
        productPipelineAccess: "read-only";
        writesAllowed: false;
        responsibility: string;
    } | {
        owner: "product-pipeline";
        productPipelineAccess: "ceremony";
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
