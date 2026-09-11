export type EbayCategoryAspect = Readonly<{
    name: string;
    required: boolean;
    /** eBay's input hint: free text vs pick-from-list. */
    mode: 'FREE_TEXT' | 'SELECTION_ONLY';
    /** Bounded sample of eBay's suggested values (may be empty). */
    values: readonly string[];
}>;
export type EbayCategoryAspectsDto = Readonly<{
    available: boolean;
    categoryId: string;
    aspects: readonly EbayCategoryAspect[];
}>;
type FetchLike = typeof fetch;
export declare function createEbayCategoryAspectsReader(dependencies?: Readonly<{
    fetchImpl?: FetchLike;
    now?: () => number;
}>): (categoryId: string) => Promise<EbayCategoryAspectsDto>;
export declare const getEbayCategoryAspects: (categoryId: string) => Promise<EbayCategoryAspectsDto>;
export {};
