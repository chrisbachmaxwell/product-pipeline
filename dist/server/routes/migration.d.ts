import { type Request, type Response } from 'express';
import { type MigrationStateApiProjection } from '../migration-state-reader.js';
declare const router: import("express-serve-static-core").Router;
type LocalMigrationState = {
    listingMappings: number;
    orderMappings: number;
    historicalEbayOrders: number;
    settings: Record<string, string>;
};
export declare function buildMigrationStatus(local: LocalMigrationState, servedAt?: string, migrationState?: MigrationStateApiProjection): {
    sourceOfTruth: {
        acceptedProductionWriterBaseline: string;
        baselineEvidence: string;
        baselineDate: string;
        productPipelineScope: string;
    };
    migrationState: MigrationStateApiProjection | undefined;
    evidence: {
        sources: ({
            sourceId: string;
            system: string;
            evidenceClass: string;
            acquisition: string;
            status: string;
            capturedAtUtc: null;
            completeness: string;
            freshness: string;
            counts: {
                listingMappings: number;
                orderMappings: number;
                historicalEbayOrders: number;
            } | {
                listingMappings?: undefined;
                orderMappings?: undefined;
                historicalEbayOrders?: undefined;
            };
            normalizedPayloadDigest: null;
            limitations: string[];
            baselineDate?: undefined;
            coverage?: undefined;
        } | {
            sourceId: string;
            system: string;
            evidenceClass: string;
            acquisition: string;
            status: string;
            capturedAtUtc: null;
            completeness: string;
            freshness: string;
            normalizedPayloadDigest: null;
            limitations: string[];
            counts?: undefined;
            baselineDate?: undefined;
            coverage?: undefined;
        } | {
            sourceId: string;
            system: string;
            evidenceClass: string;
            acquisition: string;
            status: string;
            capturedAtUtc: null;
            baselineDate: string;
            completeness: string;
            freshness: string;
            coverage: {
                complete: boolean;
                records: number;
                pages: number;
            };
            normalizedPayloadDigest: null;
            limitations: string[];
            counts?: undefined;
        })[];
    };
    responsibilityEvidence: ({
        responsibility: "price" | "orderImport" | "inventory";
        acceptedOwner: string;
        observedOwner: string;
        evidenceStatus: string;
        capturedAtUtc: null;
        baselineDate: string;
        canaryReady: boolean;
        summary: string;
    } | {
        responsibility: "listingCreate" | "listingRevise" | "listingEndRelist" | "mapping" | "fulfillment" | "feedback" | "reconciliation";
        acceptedOwner: string;
        observedOwner: null;
        evidenceStatus: string;
        capturedAtUtc: null;
        canaryReady: boolean;
        summary: string;
    })[];
    reconciliation: {
        scope: string;
        generatedAt: string;
        liveProof: boolean;
        productionParity: boolean;
        externalWrites: number;
        historicalBackfillPerformed: boolean;
        orderCreationEligible: boolean;
        counts: {
            listingMappings: number;
            orderMappings: number;
            historicalEbayOrders: number;
            historicalOrdersIneligible: number;
        };
        exceptions: {
            code: string;
            setting: string;
            detail: string;
            matchesExpected: boolean;
            effectiveBehavior: string;
        }[];
        audit: {
            availableInWebRuntime: boolean;
            note: string;
        };
    };
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
export declare function migrationStatusHandler(_req: Request, res: Response): Promise<void>;
export default router;
