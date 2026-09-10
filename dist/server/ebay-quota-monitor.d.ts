export type EbayTradingQuota = Readonly<{
    available: boolean;
    checkedAtUtc: string | null;
    aggregateCount: number | null;
    aggregateLimit: number | null;
    usedFraction: number | null;
    resetAtUtc: string | null;
    topCalls: ReadonlyArray<Readonly<{
        name: string;
        count: number;
    }>>;
    warning: boolean;
}>;
export declare const EBAY_TRADING_QUOTA_WARNING_FRACTION = 0.6;
type FetchLike = typeof fetch;
export declare function createEbayTradingQuotaReader(dependencies?: Readonly<{
    fetchImpl?: FetchLike;
    now?: () => number;
}>): () => Promise<EbayTradingQuota>;
export declare const getEbayTradingQuota: () => Promise<EbayTradingQuota>;
export {};
