export declare const RESPONSIBILITIES: readonly ["listingCreate", "listingRevise", "listingEndRelist", "mapping", "price", "inventory", "orderImport", "fulfillment", "feedback", "reconciliation"];
export type Responsibility = (typeof RESPONSIBILITIES)[number];
export type OperatorLane = 'development' | 'sandbox' | 'production-shadow';
export type EbayEnvironment = 'sandbox' | 'production';
export declare const OPERATOR_AUDIT_LOG_PATH = ".local/operator-audit/operator-cli.jsonl";
export type CurrentOwner = 'marketplace-connect' | 'manual' | 'paused' | 'product-pipeline' | 'unverified';
export type ResponsibilityOwnership = {
    currentOwner: CurrentOwner;
    productPipelineAccess: 'disabled' | 'read-only';
};
export type OperatorConfig = {
    schemaVersion: 1;
    project: 'product-pipeline';
    lane: OperatorLane;
    mode: 'read-only';
    dryRun: true;
    writesEnabled: false;
    identities: {
        shopifyStoreDomain: string;
        ebayEnvironment: EbayEnvironment;
        ebaySellerAccount: string;
        marketplaceConnectAccount: string | null;
    };
    ownership: Record<Responsibility, ResponsibilityOwnership>;
    orders: {
        importEnabled: false;
        historicalBackfill: false;
        cutoverWatermarkUtc: null;
    };
    testLane: {
        shopifyVariantGids: string[];
        skus: string[];
        ebayListingIds: string[];
        responsibilities: Responsibility[];
    };
    audit: {
        logPath: string;
    };
};
export type LoadedOperatorConfig = {
    config: OperatorConfig;
    configPath: string;
    digest: string;
};
export declare class ConfigValidationError extends Error {
    readonly issues: string[];
    constructor(issues: string[]);
}
export declare function canonicalJson(value: unknown): string;
export declare function sha256Digest(value: unknown): string;
export declare function parseOperatorConfig(value: unknown): OperatorConfig;
export declare function evaluateReadiness(config: OperatorConfig): string[];
export declare function assertPathInsideRoot(root: string, candidate: string, label: string): string;
export declare function validateRepositoryRoot(repoRoot: string): Promise<string>;
export declare function loadOperatorConfig(repoRoot: string, requestedConfigPath: string): Promise<LoadedOperatorConfig>;
