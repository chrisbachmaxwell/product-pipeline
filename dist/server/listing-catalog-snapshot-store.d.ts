import type { LiveListingCatalogSnapshot } from './live-listing-catalog.js';
export type ListingCatalogSnapshotStore = Readonly<{
    load: () => LiveListingCatalogSnapshot | null;
    save: (snapshot: LiveListingCatalogSnapshot) => void;
}>;
export declare function createListingCatalogSnapshotStore(filePath?: string): ListingCatalogSnapshotStore;
