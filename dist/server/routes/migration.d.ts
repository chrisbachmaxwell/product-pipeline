declare const router: import("express-serve-static-core").Router;
type LocalMigrationState = {
    listingMappings: number;
    orderMappings: number;
    historicalEbayOrders: number;
    settings: Record<string, string>;
};
export declare function buildMigrationStatus(local: LocalMigrationState, observedAt?: string): {
    sourceOfTruth: {
        productionWriter: string;
        productPipelineScope: string;
    };
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
            observed: string;
            expected: string;
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
    observedAt: string;
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
    })[];
    quarantine: {
        enabled: true;
        channels: ("api" | "shopify-webhooks" | "ebay-webhooks" | "scheduler" | "legacy-cli" | "authentication-routes" | "ebay-adapter" | "shopify-order-adapter" | "shopify-inventory-adapter")[];
        runtimeOverrideAvailable: false;
    };
};
export default router;
