export type ObservedOrderState = Readonly<{
    observationId: string;
    eligibleAfterWatermark: boolean;
    sourceCreationDateUtc: string;
    resolved: boolean;
    resolutionDisposition: string | null;
}>;
export type UnadvancedPageState = Readonly<{
    pageId: string;
    cursorAfter: string;
    observedCount: number;
    resolvedCount: number;
}>;
export type OrderImportStateReader = Readonly<{
    getObservationByIdentity: (ebayOrderIdentityKey: string) => ObservedOrderState | null;
    getOrderLinkByIdentity: (ebayOrderIdentityKey: string) => Readonly<{
        linkId: string;
        linkKind: string;
    }> | null;
    getCurrentCursor: () => Readonly<{
        ordinal: number;
        cursorValue: string;
    }> | null;
    getUnadvancedPage: () => UnadvancedPageState | null;
    close: () => void;
}>;
export declare function openOrderImportStateReader(input: Readonly<{
    databasePath: string;
    scopeKey: string;
}>): OrderImportStateReader;
