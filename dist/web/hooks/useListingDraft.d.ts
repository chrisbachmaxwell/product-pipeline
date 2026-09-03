import type { ListingWorkspaceResponse } from './useListingWorkspace';
export interface ListingDraftField<T = string | null> {
    shopify: T;
    ebay: T;
    draft: T;
    editable: boolean;
}
export interface ListingDraftResponse {
    schemaVersion: 1;
    mode: 'local_draft_only';
    catalogId: string;
    identity: {
        shopifyProductGid: string;
        shopifyVariantGid: string;
        rawSku: string;
        ebaySellerId: 'usedcameragear';
        ebayMarketplaceId: 'EBAY_US';
        managementModel: 'inventory_api' | 'trading_api' | 'unmanaged' | 'unknown';
        ebayInventorySku: string | null;
        ebayOfferId: string | null;
        ebayListingId: string | null;
    };
    base: {
        catalogObservedAtUtc: string;
        detailObservedAtUtc: string | null;
        sourceDigest: `sha256:${string}`;
        ebayDigest: `sha256:${string}`;
    };
    revision: null | {
        revisionId: string;
        revisionNumber: number;
        revisionDigest: `sha256:${string}`;
        state: 'draft';
        createdAtUtc: string;
    };
    sections: {
        listing: {
            title: ListingDraftField;
            category: ListingDraftField;
            condition: ListingDraftField;
            conditionDescription: ListingDraftField;
            price: ListingDraftField;
            quantity: ListingDraftField;
        };
        content: {
            description: ListingDraftField;
            images: ListingDraftField;
            itemSpecifics: ListingDraftField;
            identifiers: ListingDraftField;
        };
        delivery: {
            fulfillmentPolicyId: ListingDraftField;
            paymentPolicyId: ListingDraftField;
            returnPolicyId: ListingDraftField;
            merchantLocation: ListingDraftField;
        };
    };
    capabilities: {
        saveDraft: boolean;
        previewChanges: boolean;
        apply: false;
        publish: false;
    };
    externalWritesPerformed: 0;
}
export interface ListingDraftSaveInput {
    schemaVersion: 1;
    action: 'save_local_draft';
    catalogId: string;
    expectedRevisionDigest: `sha256:${string}` | null;
    base: {
        sourceDigest: `sha256:${string}`;
        ebayDigest: `sha256:${string}`;
    };
    draft: {
        title: string | null;
        category: string | null;
        condition: string | null;
        conditionDescription: string | null;
        description: string | null;
        images: string | null;
        itemSpecifics: string | null;
        fulfillmentPolicyId: string | null;
        paymentPolicyId: string | null;
        returnPolicyId: string | null;
        merchantLocation: string | null;
    };
}
export declare const isListingDraftSaveInput: (value: unknown) => value is ListingDraftSaveInput;
export declare const canonicalDraftItemSpecifics: (serialized: string) => string | null;
export declare const isListingDraftResponse: (value: unknown, expectedCatalogId?: string) => value is ListingDraftResponse;
export declare const canonicalDraftImages: (value: readonly string[]) => string;
export declare const verifiedDraftImageUrl: (value: string) => string | null;
export declare const parseDraftImages: (value: string | null) => string[];
export declare const effectiveDraftImages: (fieldValue: ListingDraftField) => string[];
export declare const draftFieldValue: (value: ListingDraftField) => string;
export declare const inheritedFieldValue: (value: ListingDraftField) => string;
export declare const isListingDraftBoundToWorkspace: (draft: ListingDraftResponse, workspace: ListingWorkspaceResponse) => boolean;
export declare const useListingDraft: (catalogId: string | undefined) => import("@tanstack/react-query").UseQueryResult<ListingDraftResponse, Error>;
export declare const useSaveListingDraft: (catalogId: string | undefined) => import("@tanstack/react-query").UseMutationResult<ListingDraftResponse, Error, ListingDraftSaveInput, unknown>;
