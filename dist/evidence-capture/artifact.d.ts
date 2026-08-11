import { type LoadedEvidenceCaptureConfig } from './config.js';
export declare const EVIDENCE_SIGNING_KEY_ENV = "PRODUCT_PIPELINE_EVIDENCE_SIGNING_KEY_PKCS8_B64";
export type EvidenceSource = 'shopify' | 'ebay' | 'marketplace-connect';
export type EvidenceArtifactPayload<T> = {
    schemaVersion: 1;
    kind: 'product-pipeline-authoritative-read-evidence';
    source: EvidenceSource;
    captureId: string;
    generatedAtUtc: string;
    scopeDigest: `sha256:${string}`;
    configDigest: `sha256:${string}`;
    collector: {
        name: 'product-pipeline-evidence-capture';
        version: 1;
        buildCommit: string;
    };
    safety: {
        externalReadsPerformed: boolean;
        externalWrites: 0;
        historicalBackfill: false;
        oauthAcquisition: false;
        accessRefresh: false;
        rawPayloadPersistence: false;
        personalDataPersistence: false;
        ownershipTransferred: false;
        cutoverReady: false;
        productionParity: false;
    };
    evidence: T;
};
export type EvidenceArtifact<T> = {
    payload: EvidenceArtifactPayload<T>;
    signature: {
        algorithm: 'Ed25519';
        keyId: string;
        payloadDigest: `sha256:${string}`;
        valueBase64: string;
    };
};
export type EvidenceArtifactSigner = Readonly<{
    sign: <T>(payload: EvidenceArtifactPayload<T>) => EvidenceArtifact<T>;
    keyId: string;
}>;
export declare class EvidenceArtifactError extends Error {
    constructor(message: string);
}
export declare function buildEvidencePayload<T>(input: {
    loaded: LoadedEvidenceCaptureConfig;
    source: EvidenceSource;
    evidence: T;
    generatedAtUtc: string;
    externalReadsPerformed: boolean;
    captureId?: string;
}): EvidenceArtifactPayload<T>;
export declare function createEvidenceArtifactSigner(input: {
    loaded: LoadedEvidenceCaptureConfig;
    environment: Readonly<Record<string, string | undefined>>;
}): EvidenceArtifactSigner;
export declare function verifyEvidenceArtifact<T>(input: {
    artifact: EvidenceArtifact<T>;
    loaded: LoadedEvidenceCaptureConfig;
}): void;
/**
 * Reads one artifact emitted by this tool from the fixed ignored directory.
 * The file must be canonical JSON, regular, private, single-linked, and named
 * from its signed digest. This operation never creates or repairs storage.
 */
export declare function readEvidenceArtifact(input: {
    loaded: LoadedEvidenceCaptureConfig;
    requestedArtifactPath: string;
}): EvidenceArtifact<unknown>;
export declare function writeEvidenceArtifact<T>(input: {
    artifact: EvidenceArtifact<T>;
    loaded: LoadedEvidenceCaptureConfig;
}): {
    relativePath: string;
    artifactDigest: `sha256:${string}`;
};
