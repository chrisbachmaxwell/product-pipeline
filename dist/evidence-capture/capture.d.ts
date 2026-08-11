import { type EvidenceArtifact, type EvidenceSource } from './artifact.js';
import { EVIDENCE_CAPTURE_CONFIG_RELATIVE_PATH, type LoadedEvidenceCaptureConfig } from './config.js';
import { type EbayInventoryEvidence, type EbayOrderEvidence } from './ebay.js';
import { type EvidenceFetch } from './network.js';
import { type ShopifyAuthoritativeEvidence } from './shopify.js';
export type CaptureSource = Extract<EvidenceSource, 'shopify' | 'ebay'>;
export declare class EvidenceCaptureCommandError extends Error {
    readonly code: 'source-denied' | 'scope-confirmation-denied' | 'build-identity-denied' | 'window-denied' | 'record-limit-exceeded' | 'artifact-path-denied' | 'artifact-schema-denied';
    constructor(code: EvidenceCaptureCommandError['code']);
}
export type EvidenceCapturePreflight = Readonly<{
    schemaVersion: 1;
    command: 'preflight';
    status: 'locally-ready' | 'blocked';
    lane: 'sandbox' | 'production-shadow';
    mode: 'authoritative-read-capture';
    scopeDigest: `sha256:${string}`;
    configDigest: `sha256:${string}`;
    configPath: typeof EVIDENCE_CAPTURE_CONFIG_RELATIVE_PATH;
    networkPerformed: false;
    remoteAuthorityVerified: false;
    runtimeBuild: Readonly<{
        configuredCommit: string;
        headCommitMatches: boolean;
        collectorTreeClean: boolean;
    }>;
    historicalVerificationContextArchived: false;
    externalWrites: 0;
    historicalBackfill: false;
    sourceReadiness: Readonly<{
        shopify: boolean;
        ebay: boolean;
    }>;
    authorityPresence: Readonly<{
        shopifyAccessPresent: boolean;
        ebayAccessPresent: boolean;
        ebayExpiryMetadataPresent: boolean;
        ebayScopeMetadataPresent: boolean;
        signingAuthorityPresent: boolean;
    }>;
    blockers: readonly string[];
    cutoverBlockers: readonly string[];
}>;
export type EvidenceCaptureRuntimeBuildIdentity = Readonly<{
    headCommit: string;
    collectorTreeClean: boolean;
}>;
export type ShopifyCaptureEvidence = Readonly<{
    schemaVersion: 1;
    kind: 'shopify-authoritative-read-capture';
    identity: ShopifyAuthoritativeEvidence['identity'];
    variants: ShopifyAuthoritativeEvidence['variants'];
    orders: ShopifyAuthoritativeEvidence['orders'];
    provenance: ShopifyAuthoritativeEvidence['provenance'];
}>;
type SafeEbayInventoryEvidence = Omit<EbayInventoryEvidence, 'safeguards'> & Readonly<{
    safeguards: Readonly<{
        getOnly: true;
        oauthRefreshAbsent: true;
        externalWritesSupported: false;
    }>;
}>;
type SafeEbayOrderEvidence = Omit<EbayOrderEvidence, 'safeguards' | 'rawInclusiveRecordCount'> & Readonly<{
    safeguards: Readonly<{
        getOnly: true;
        oauthRefreshAbsent: true;
        externalWritesSupported: false;
        orderFieldsMinimized: true;
    }>;
    inclusiveRecordCount: number;
}>;
export type EbayCaptureEvidence = Readonly<{
    schemaVersion: 1;
    kind: 'ebay-authoritative-read-capture';
    identity: Readonly<{
        userId: string;
        registrationMarketplaceId: string;
    }>;
    inventory: SafeEbayInventoryEvidence;
    orders: SafeEbayOrderEvidence;
}>;
export type SourceCaptureEvidence = ShopifyCaptureEvidence | EbayCaptureEvidence;
export type EvidenceCollectionResult = Readonly<{
    schemaVersion: 1;
    command: 'collect';
    status: 'captured';
    source: CaptureSource;
    lane: 'sandbox' | 'production-shadow';
    generatedAtUtc: string;
    orderWindow: Readonly<{
        startUtc: string;
        endUtc: string;
    }>;
    scopeDigest: `sha256:${string}`;
    configDigest: `sha256:${string}`;
    artifact: Readonly<{
        relativePath: string;
        digest: `sha256:${string}`;
    }>;
    counts: Readonly<{
        primary: number;
        secondary: number;
        orders: number;
    }>;
    networkReadsPerformed: true;
    externalWrites: 0;
    historicalBackfill: false;
    productionParity: false;
    cutoverReady: false;
    historicalVerificationContextArchived: false;
}>;
export type EvidenceVerificationResult = Readonly<{
    schemaVersion: 1;
    command: 'verify';
    status: 'verified';
    source: CaptureSource;
    generatedAtUtc: string;
    artifactRelativePath: string;
    artifactDigest: `sha256:${string}`;
    scopeDigest: `sha256:${string}`;
    configDigest: `sha256:${string}`;
    counts: Readonly<{
        primary: number;
        secondary: number;
        orders: number;
    }>;
    signatureValid: true;
    sourceSchemaValid: true;
    freshness: 'fresh' | 'stale' | 'future';
    currentReadEvidence: boolean;
    parityUseAllowed: false;
    signedCollectorBuildCommit: string;
    currentCheckoutMatchesSignedBuild: boolean;
    currentCollectorTreeClean: boolean;
    historicalVerificationContextArchived: false;
    externalWrites: 0;
    historicalBackfill: false;
    productionParity: false;
    cutoverReady: false;
}>;
export declare function runEvidenceCapturePreflight(input: {
    repositoryRoot: string;
    environment: Readonly<Record<string, string | undefined>>;
    now: () => Date;
    runtimeBuild: EvidenceCaptureRuntimeBuildIdentity;
}): EvidenceCapturePreflight;
export declare function runEvidenceCollection(input: {
    repositoryRoot: string;
    environment: Readonly<Record<string, string | undefined>>;
    fetch: EvidenceFetch;
    source: string;
    confirmScopeDigest: string;
    orderStartUtc: string;
    orderEndUtc: string;
    now: () => Date;
    runtimeBuild: EvidenceCaptureRuntimeBuildIdentity;
}): Promise<EvidenceCollectionResult>;
export declare function assertSourceArtifactSchema(artifactInput: unknown, loaded: LoadedEvidenceCaptureConfig): asserts artifactInput is EvidenceArtifact<SourceCaptureEvidence>;
export declare function verifyLocalEvidenceArtifact(input: {
    repositoryRoot: string;
    requestedArtifactPath: string;
    now: () => Date;
    runtimeBuild: EvidenceCaptureRuntimeBuildIdentity;
}): EvidenceVerificationResult;
export {};
