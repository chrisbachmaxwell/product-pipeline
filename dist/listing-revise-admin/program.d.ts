import { Command } from 'commander';
import { openMigrationStore } from '../migration-store/index.js';
import { openListingControlStoreReadOnly } from '../listing-control-store/index.js';
import type { ListingWorkspaceDto } from '../server/listing-workspace-reader.js';
import { type ListingReviseDispatchAdapter } from './dispatch-adapter.js';
export type ListingReviseAdminIo = {
    stdout: (message: string) => void;
    stderr: (message: string) => void;
    setExitCode: (code: number) => void;
};
export type ListingReviseAdminDependencies = Readonly<{
    readWorkspace?: (catalogId: string) => Promise<ListingWorkspaceDto>;
    draftDatabasePath?: () => string | undefined;
    openDraftStoreReadOnly?: typeof openListingControlStoreReadOnly;
    openMigration?: typeof openMigrationStore;
    createAdapter?: () => ListingReviseDispatchAdapter;
    now?: () => Date;
    uuid?: () => string;
    io?: ListingReviseAdminIo;
}>;
export declare function buildListingReviseAdminProgram(dependencies?: ListingReviseAdminDependencies): Command;
