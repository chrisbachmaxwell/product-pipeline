export type SanitizedFixtureRecords<T> = Readonly<{
    records: readonly T[];
    recordCount: number;
    responseBytes: number;
    datasetDigest: string;
}>;
/**
 * Produces an immutable, canonical, secret/PII-denied fixture dataset and
 * computes count, bytes, and digest locally rather than trusting a dispatcher.
 */
export declare function sanitizeFixtureRecords<T>(rawRecords: unknown, maxRecords: number, maxBytes: number): SanitizedFixtureRecords<T>;
