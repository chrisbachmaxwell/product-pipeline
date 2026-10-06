import { type AspectProposer, type AutofillDependencies, type AutofillDraftService } from './listing-autofill.js';
export type ListingPrepItem = Readonly<{
    catalogId: string;
    sku: string;
    title: string;
    /** ready = nothing missing; needs_input = a person must fill `missing`. */
    state: 'ready' | 'needs_input' | 'unavailable' | 'error';
    filled: readonly string[];
    missing: readonly string[];
    checkedAtUtc: string;
}>;
export type ListingPrepStatus = Readonly<{
    state: 'idle' | 'running';
    lastRunAtUtc: string | null;
    aiArmed: boolean;
    items: readonly ListingPrepItem[];
}>;
type SnapshotRow = {
    id: string;
    readyToList?: boolean;
    readyToListGaps?: readonly string[];
    shopify: {
        sku: string;
        title: string;
    } | null;
};
export type ListingPrepDependencies = Readonly<{
    getSnapshot?: () => Promise<{
        rows: readonly SnapshotRow[];
    }>;
    draftService?: AutofillDraftService;
    getCategoryAspects?: AutofillDependencies['getCategoryAspects'];
    createProposer?: () => Promise<AspectProposer | null>;
    publishBusy?: () => boolean;
    sleep?: (ms: number) => Promise<void>;
    now?: () => string;
}>;
export declare function getListingPrepStatus(): ListingPrepStatus;
/** Test hook. */
export declare function resetListingPrepState(): void;
/**
 * One prep pass over the ready queue. Resolves false when skipped (already
 * running, or a publish run is in flight — publishing owns the drafts then).
 */
export declare function runListingPrep(dependencies?: ListingPrepDependencies): Promise<boolean>;
/** A product was created or edited: prepare it within a few minutes. */
export declare function notifyProductChanged(dependencies?: ListingPrepDependencies): boolean;
export declare function initListingPrepSchedule(dependencies?: ListingPrepDependencies): NodeJS.Timeout | null;
export {};
