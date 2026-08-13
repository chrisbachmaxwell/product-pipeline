import { type ProductionCan3570ListingEvidence } from './evidence/production-can3570-authoritative-listing.v1.js';
export type AuthoritativeListingStatus = 'attention' | 'ready' | 'active' | 'ended';
export type AuthoritativeListingProjection = Readonly<{
    id: string;
    shopify: Readonly<{
        productId: string;
        variantId: string;
        sku: string;
        title: string;
        primaryImageUrl: string | null;
        imageCount: number;
    }>;
    ebay: Readonly<{
        listingId: string;
        offerId: string;
        url: string;
    }>;
    price: Readonly<{
        amount: string;
        currency: 'USD';
    }> | null;
    lifecycleStatus: AuthoritativeListingStatus;
    lastVerifiedAtUtc: string;
    audit: Readonly<{
        verified: boolean;
        evidenceState: 'verified' | 'invalid' | 'unavailable';
        unresolvedCount: number;
        recoverySupported: boolean;
        currentRemoteStateVerified: boolean;
    }>;
}>;
export type AuthoritativeListingsPage = Readonly<{
    schemaVersion: 1;
    data: readonly AuthoritativeListingProjection[];
    total: number;
    limit: number;
    offset: number;
    source: 'production-listing-audit-ledger';
    evidenceKind: 'verified_snapshot';
    authoritative: false;
    remoteReadPerformed: false;
    externalWritesPerformed: 0;
}>;
export declare class AuthoritativeListingEvidenceError extends Error {
    constructor();
}
export declare function digestAuthoritativeListingEvidence(value: unknown): `sha256:${string}`;
/**
 * Strictly validates the checked-in evidence asset. This accepts no general
 * listing shape: every source proof and public identifier is pinned to the
 * verified Canon canary. A changed or expanded artifact fails closed.
 */
export declare function verifyAuthoritativeListingEvidence(evidence: unknown): asserts evidence is ProductionCan3570ListingEvidence;
export declare function readAuthoritativeListingsPage(input: Readonly<{
    limit: number;
    offset: number;
    search?: string;
    status?: AuthoritativeListingStatus;
    evidence?: unknown;
}>): AuthoritativeListingsPage;
