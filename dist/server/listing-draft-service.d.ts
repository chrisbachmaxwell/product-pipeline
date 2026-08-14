import { openListingControlStore, openListingControlStoreReadOnly, type Digest, type ListingFieldInput, type ListingFieldName, type ListingIdentity } from '../listing-control-store/index.js';
import { type ListingWorkspaceDto } from './listing-workspace-reader.js';
export { LISTING_DRAFT_SCOPE } from '../listing-control-config.js';
export type ListingDraftField = Readonly<{
    shopify: string | null;
    ebay: string | null;
    draft: string | null;
    editable: boolean;
}>;
export type ListingDraftDto = Readonly<{
    schemaVersion: 1;
    mode: 'local_draft_only';
    catalogId: string;
    identity: ListingIdentity;
    base: Readonly<{
        catalogObservedAtUtc: string;
        detailObservedAtUtc: string | null;
        sourceDigest: Digest;
        ebayDigest: Digest;
    }>;
    revision: null | Readonly<{
        revisionId: string;
        revisionNumber: number;
        revisionDigest: Digest;
        state: 'draft';
        createdAtUtc: string;
    }>;
    sections: Readonly<{
        listing: Readonly<{
            title: ListingDraftField;
            category: ListingDraftField;
            condition: ListingDraftField;
            conditionDescription: ListingDraftField;
            price: ListingDraftField;
            quantity: ListingDraftField;
        }>;
        content: Readonly<{
            description: ListingDraftField;
            images: ListingDraftField;
            itemSpecifics: ListingDraftField;
            identifiers: ListingDraftField;
        }>;
        delivery: Readonly<{
            fulfillmentPolicyId: ListingDraftField;
            paymentPolicyId: ListingDraftField;
            returnPolicyId: ListingDraftField;
            merchantLocation: ListingDraftField;
        }>;
    }>;
    capabilities: Readonly<{
        saveDraft: boolean;
        previewChanges: boolean;
        apply: false;
        publish: false;
    }>;
    externalWritesPerformed: 0;
}>;
export type SaveListingDraftRequest = Readonly<{
    schemaVersion: 1;
    action: 'save_local_draft';
    catalogId: string;
    expectedRevisionDigest: Digest | null;
    base: Readonly<{
        sourceDigest: Digest;
        ebayDigest: Digest;
    }>;
    draft: Readonly<{
        title: string | null;
        category: string | null;
        condition: string | null;
        conditionDescription: string | null;
        description: string | null;
        images: string | null;
        fulfillmentPolicyId: string | null;
        paymentPolicyId: string | null;
        returnPolicyId: string | null;
        merchantLocation: string | null;
    }>;
}>;
export type ListingDraftFailureCode = 'LISTING_DRAFT_INVALID' | 'LISTING_DRAFT_FORBIDDEN' | 'LISTING_DRAFT_NOT_FOUND' | 'LISTING_DRAFT_STALE' | 'LISTING_DRAFT_UNAVAILABLE';
export declare class ListingDraftServiceError extends Error {
    readonly code: ListingDraftFailureCode;
    constructor(code: ListingDraftFailureCode);
}
declare function canonicalImages(value: unknown): string | null;
/** Strict browser contract. Unknown/provider/identity/provenance keys fail closed. */
export declare function parseSaveListingDraftRequest(value: unknown): SaveListingDraftRequest;
declare function canonicalJson(value: unknown): string;
declare function htmlToPlainText(value: string | null): string | null;
type Values = Record<ListingFieldName, string | null>;
type Basis = Readonly<{
    workspace: ListingWorkspaceDto;
    identity: ListingIdentity;
    source: Values;
    observed: Values;
    sourceDigest: Digest;
    ebayDigest: Digest;
    ebayObservedAtUtc: string;
}>;
declare function eligibleBasis(workspace: ListingWorkspaceDto): Basis;
type DraftValues = Partial<Record<ListingFieldName, string | null>>;
declare function fieldsForRevision(basis: Basis, draft: DraftValues): ListingFieldInput[];
export type ListingDraftBasis = Basis;
/**
 * Derive the strict draft-eligible basis (identity, normalized source and
 * observed field values, and semantic digests) from one live workspace read.
 * The isolated listing-revise operator CLI uses this to bind a dispatch to
 * exactly the same normalization the draft workspace saved against; it
 * performs no store or provider access itself.
 */
export declare function deriveListingDraftBasis(workspaceDto: ListingWorkspaceDto): ListingDraftBasis;
export type ListingDraftServiceDependencies = Readonly<{
    readWorkspace?: (catalogId: string) => Promise<ListingWorkspaceDto>;
    databasePath?: () => string | undefined;
    openReadOnly?: typeof openListingControlStoreReadOnly;
    openWritable?: typeof openListingControlStore;
    now?: () => Date;
    uuid?: () => string;
    writerInstanceReady?: () => boolean;
}>;
export declare function createListingDraftService(dependencies?: ListingDraftServiceDependencies): Readonly<{
    get(catalogId: string, saveAuthorized?: boolean): Promise<ListingDraftDto>;
    save(request: SaveListingDraftRequest, actor: string): Promise<ListingDraftDto>;
}>;
export type ListingDraftService = ReturnType<typeof createListingDraftService>;
export declare const LISTING_DRAFT_SERVICE_TESTING: Readonly<{
    eligibleBasis: typeof eligibleBasis;
    fieldsForRevision: typeof fieldsForRevision;
    canonicalImages: typeof canonicalImages;
    htmlToPlainText: typeof htmlToPlainText;
    canonicalJson: typeof canonicalJson;
}>;
