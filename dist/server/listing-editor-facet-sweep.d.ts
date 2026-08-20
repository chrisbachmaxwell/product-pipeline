import type { ListingEditorFacetObservation, LiveListingCatalogSnapshot } from './live-listing-catalog.js';
import { type ListingWorkspaceDto } from './listing-workspace-reader.js';
export type EditorFacetSweep = Readonly<{
    /**
     * Current cached aggregate (possibly empty), returned synchronously.
     * Starts one background sweep when the cache is empty or expired; never
     * waits on it and never throws.
     */
    getObservations: () => readonly ListingEditorFacetObservation[];
    /** Test/diagnostic seam: resolves once no sweep is in flight. */
    settle: () => Promise<void>;
}>;
/**
 * Project one workspace DTO's enriched eBay detail into the exact
 * `editorFacets` observation shape, dropping any absent or unsafe field.
 * Returns null when the detail is missing, unidentifiable, or carries no
 * facet at all.
 */
declare function observationFromWorkspace(dto: unknown): ListingEditorFacetObservation | null;
/**
 * Active listing identities from the cached census snapshot: catalog row ids
 * whose row is bound to exactly one active eBay listing, deduplicated by
 * listing id, capped at the per-sweep bound.
 */
declare function collectSweepIdentities(snapshot: LiveListingCatalogSnapshot): readonly string[];
export declare function createEditorFacetSweep(dependencies: Readonly<{
    getSnapshot: () => Promise<LiveListingCatalogSnapshot>;
    readListingDetail: (rowId: string) => Promise<ListingWorkspaceDto>;
    now?: () => number;
}>): EditorFacetSweep;
/**
 * Production sweep bound to the same cached census snapshot and the same
 * per-listing workspace read path the workspace endpoint uses. Constructing
 * it performs no work: the first metadata request drives the first sweep.
 */
export declare const editorFacetSweep: EditorFacetSweep;
export declare const EDITOR_FACET_SWEEP_TESTING: Readonly<{
    SWEEP_TTL_MS: number;
    MAX_SWEEP_LISTINGS: 150;
    SWEEP_CONCURRENCY: 3;
    collectSweepIdentities: typeof collectSweepIdentities;
    observationFromWorkspace: typeof observationFromWorkspace;
}>;
export {};
