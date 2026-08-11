export declare const EVIDENCE_CAPTURE_CONFIG_RELATIVE_PATH = "config/evidence-capture.json";
export declare const EVIDENCE_CAPTURE_OUTPUT_DIRECTORY = ".local/evidence-capture";
export type EvidenceCaptureLane = 'sandbox' | 'production-shadow';
export type EvidenceCaptureConfig = {
    schemaVersion: 1;
    project: 'product-pipeline';
    lane: EvidenceCaptureLane;
    mode: 'authoritative-read-capture';
    outputDirectory: typeof EVIDENCE_CAPTURE_OUTPUT_DIRECTORY;
    identities: {
        shopifyStoreDomain: string;
        shopifyShopGid: string;
        shopifyAppGid: string;
        ebayEnvironment: 'sandbox' | 'production';
        ebayUserId: string;
        ebayMarketplaceId: 'EBAY_US';
        ebayRegistrationMarketplaceId: 'EBAY_US';
    };
    collector: {
        name: 'product-pipeline-evidence-capture';
        version: 1;
        buildCommit: string;
    };
    signing: {
        keyId: string;
        publicKeySpkiDerBase64: string;
    };
    limits: {
        requestTimeoutMs: number;
        maxPagesPerSource: number;
        maxRecordsPerSource: number;
        maxResponseBytes: number;
        minimumEbayAccessValiditySeconds: number;
        maxOrderWindowHours: 168;
    };
    safety: {
        externalPlatformReads: true;
        externalPlatformWrites: false;
        historicalBackfill: false;
        oauthAcquisition: false;
        accessRefresh: false;
        rawPayloadPersistence: false;
        personalDataPersistence: false;
        cutoverWatermarkUtc: null;
        ownershipTransferAllowed: false;
    };
};
export type LoadedEvidenceCaptureConfig = {
    config: EvidenceCaptureConfig;
    repositoryRoot: string;
    configAbsolutePath: string;
    outputDirectoryAbsolutePath: string;
    scopeDigest: `sha256:${string}`;
    configDigest: `sha256:${string}`;
};
export declare class EvidenceCaptureConfigError extends Error {
    readonly issues: string[];
    constructor(issues: string[]);
}
export declare function canonicalJson(value: unknown): string;
export declare function sha256Digest(value: unknown): `sha256:${string}`;
export declare function parseEvidenceCaptureConfig(value: unknown): EvidenceCaptureConfig;
export declare function loadEvidenceCaptureConfig(input: {
    repositoryRoot: string;
    requestedConfigPath: string;
}): LoadedEvidenceCaptureConfig;
