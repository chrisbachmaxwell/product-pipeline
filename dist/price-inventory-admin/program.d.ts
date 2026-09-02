import { Command } from 'commander';
import { openMigrationStore } from '../migration-store/index.js';
import { type ListingDraftBasis } from '../server/listing-draft-service.js';
import type { ListingWorkspaceDto } from '../server/listing-workspace-reader.js';
import type { LiveListingCatalogSnapshot } from '../server/live-listing-catalog.js';
import { type QuantityBeliefStore } from './quantity-beliefs.js';
import { type AlignmentField, type DerivedAlignmentManifest } from './manifest.js';
import { type PriceInventoryDispatchAdapter } from './dispatch-adapter.js';
import { type TradingAlignDispatchAdapter } from './trading-dispatch-adapter.js';
export type PriceInventoryAdminIo = {
    stdout: (message: string) => void;
    stderr: (message: string) => void;
    setExitCode: (code: number) => void;
};
export type PriceInventoryAdminDependencies = Readonly<{
    readWorkspace?: (catalogId: string) => Promise<ListingWorkspaceDto>;
    openMigration?: typeof openMigrationStore;
    createAdapter?: () => PriceInventoryDispatchAdapter;
    createTradingAdapter?: () => TradingAlignDispatchAdapter;
    /** Catalog enumeration for `align-sweep`; unused by the one-action path. */
    getSnapshot?: () => Promise<LiveListingCatalogSnapshot>;
    /** Quantity-belief cache for `align-sweep`; unused by the one-action path. */
    openBeliefs?: (databasePath: string) => QuantityBeliefStore;
    now?: () => Date;
    uuid?: () => string;
    io?: PriceInventoryAdminIo;
}>;
type DerivedTarget = {
    basis: ListingDraftBasis;
    field: AlignmentField;
    derived: DerivedAlignmentManifest;
};
/**
 * The Quantity value to send in a Trading `ReviseInventoryStatus`.
 *
 * Shopify tracks AVAILABLE stock. eBay Trading tracks TOTAL listed quantity
 * and derives available as `total - sold` — the workspace reports exactly
 * that, with `availableQuantityBasis: 'total_minus_sold'`. Drift is detected
 * on available (correctly), but writing the Shopify available figure straight
 * into `Quantity` sets the TOTAL, so on a listing with sales the result is
 * always short by the sold count and the drift can never close.
 *
 * Observed in Production on SKU 16437396: Shopify available 106, eBay total
 * 102 / sold 2 / available 100. Writing 106 would leave available at 104, so
 * the identical manifest re-derives on the next sweep — and because the
 * intent key is the manifest digest, idempotency then blocks the listing from
 * ever being re-aligned (REALIGN_INTENT_ALREADY_RECORDED).
 *
 * Adding the sold count makes AVAILABLE converge, which is the quantity that
 * actually matters to a buyer. Inventory-API offers are unaffected: that path
 * sets availableQuantity directly and needs no adjustment.
 */
export declare function tradingQuantityToWrite(target: DerivedTarget, availableAfter: number): number;
export declare function buildPriceInventoryAdminProgram(dependencies?: PriceInventoryAdminDependencies): Command;
export {};
