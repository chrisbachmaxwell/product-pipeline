import type { MigrationStatusResponse } from './hooks/useApi';
import { type MigrationResponsibility } from '../safety/responsibilities.js';
export declare const EVIDENCE_SOURCE_KEYS: readonly ["productPipeline", "shopify", "ebay", "marketplaceConnect"];
export type EvidenceSourceKey = (typeof EVIDENCE_SOURCE_KEYS)[number];
export declare const RESPONSIBILITY_KEYS: readonly ["orderImport", "price", "inventory", "listingCreate", "listingRevise", "listingEndRelist", "mapping", "fulfillment", "feedback", "reconciliation"];
export type ResponsibilityKey = MigrationResponsibility;
export declare const RESPONSIBILITY_LABELS: Record<ResponsibilityKey, string>;
export interface NormalizedEvidenceSource {
    key: EvidenceSourceKey;
    label: string;
    evidenceClass: string;
    status: string;
    completeness: string;
    freshness: string;
    capturedAt: string | null;
    asOfStart: string | null;
    asOfEnd: string | null;
    recordCount: number | null;
    counts: Record<string, number>;
    digest: string | null;
    limitations: string[];
    critical: boolean;
}
export interface NormalizedResponsibilityEvidence {
    responsibility: ResponsibilityKey;
    label: string;
    acceptedOwner: string;
    evidenceStatus: string;
    observedOwner: string | null;
    capturedAt: string | null;
    summary: string;
    critical: boolean;
}
/**
 * Project additive server evidence into four fixed, redacted source cards. A
 * missing source is always critical; response-serving timestamps are never
 * substituted for source capture time.
 */
export declare function normalizeEvidenceSources(status: MigrationStatusResponse | undefined): NormalizedEvidenceSource[];
export declare function normalizeResponsibilityEvidence(status: MigrationStatusResponse | undefined): NormalizedResponsibilityEvidence[];
export declare function formatEvidenceTime(value: string | null | undefined): string;
export declare function booleanPolicyState(value: boolean | undefined, labels: {
    safe: string;
    unsafe: string;
}, safeValue?: boolean): {
    label: string;
    tone: 'success' | 'critical';
};
