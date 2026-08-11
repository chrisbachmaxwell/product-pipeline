export declare const HARD_READ_LIMITS: Readonly<{
    timeoutMs: 15000;
    maxPages: 100;
    maxRecords: 10000;
    maxResponseBytes: number;
}>;
export type ReadLimits = Readonly<{
    timeoutMs: number;
    maxPages: number;
    maxRecords: number;
    maxResponseBytes: number;
}>;
export declare function validateReadLimits(input: unknown): ReadLimits;
