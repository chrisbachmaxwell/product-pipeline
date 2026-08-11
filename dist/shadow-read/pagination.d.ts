export type PaginationCaps = Readonly<{
    maxPages: number;
    maxRecords: number;
}>;
export type CursorPage<T> = Readonly<{
    requestCursor: string | null;
    nextCursor: string | null;
    records: readonly T[];
    pageComplete: boolean;
    reportedTotal: number | null;
}>;
export type OffsetPage<T> = Readonly<{
    offset: number;
    limit: number;
    records: readonly T[];
    pageComplete: boolean;
    reportedTotal: number;
}>;
export type CompletePaginationProof<T> = Readonly<{
    complete: true;
    records: readonly T[];
    pageCount: number;
    recordCount: number;
    reportedTotal: number | null;
    terminalCursorDigest: string | null;
    datasetDigest: string;
    fixtureOnly: true;
    liveProof: false;
}>;
export type PaginationOptions<T> = Readonly<{
    caps: PaginationCaps;
    expectedTotal: number | null;
    stableId: (record: T) => string;
}>;
/**
 * Validates already collected cursor pages. It performs no requests and emits a
 * `complete: true` proof only after terminal-cursor, count, and identity checks.
 */
export declare function collectCompleteCursorPages<T>(rawPages: readonly CursorPage<T>[], rawOptions: PaginationOptions<T>): CompletePaginationProof<T>;
/**
 * Validates already collected offset pages. It requires a consistent source
 * total and contiguous, full non-terminal pages before emitting completeness.
 */
export declare function collectCompleteOffsetPages<T>(rawPages: readonly OffsetPage<T>[], rawOptions: PaginationOptions<T>): CompletePaginationProof<T>;
