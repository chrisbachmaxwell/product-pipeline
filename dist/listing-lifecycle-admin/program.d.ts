import { Command } from 'commander';
import { openMigrationStore } from '../migration-store/index.js';
import { openListingControlStoreReadOnly } from '../listing-control-store/index.js';
import type { ListingWorkspaceDto } from '../server/listing-workspace-reader.js';
import { type ListingCreateDispatchAdapter } from './create-dispatch-adapter.js';
import { type InventoryWithdrawDispatchAdapter, type TradingEndDispatchAdapter } from './end-dispatch-adapter.js';
export type ListingLifecycleAdminIo = {
    stdout: (message: string) => void;
    stderr: (message: string) => void;
    setExitCode: (code: number) => void;
};
export type ListingLifecycleAdminDependencies = Readonly<{
    readWorkspace?: (catalogId: string) => Promise<ListingWorkspaceDto>;
    draftDatabasePath?: () => string | undefined;
    openDraftStoreReadOnly?: typeof openListingControlStoreReadOnly;
    openMigration?: typeof openMigrationStore;
    createCreateAdapter?: () => ListingCreateDispatchAdapter;
    createTradingEndAdapter?: () => TradingEndDispatchAdapter;
    createWithdrawAdapter?: () => InventoryWithdrawDispatchAdapter;
    now?: () => Date;
    uuid?: () => string;
    io?: ListingLifecycleAdminIo;
}>;
export declare function buildListingLifecycleAdminProgram(dependencies?: ListingLifecycleAdminDependencies): Command;
