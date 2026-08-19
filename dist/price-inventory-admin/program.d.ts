import { Command } from 'commander';
import { openMigrationStore } from '../migration-store/index.js';
import type { ListingWorkspaceDto } from '../server/listing-workspace-reader.js';
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
    now?: () => Date;
    uuid?: () => string;
    io?: PriceInventoryAdminIo;
}>;
export declare function buildPriceInventoryAdminProgram(dependencies?: PriceInventoryAdminDependencies): Command;
