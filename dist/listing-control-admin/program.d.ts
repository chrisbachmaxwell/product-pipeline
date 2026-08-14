import { Command } from 'commander';
export type ListingControlAdminDependencies = Readonly<{
    databasePath?: () => string | undefined;
    now?: () => Date;
    output?: (value: string) => void;
}>;
export declare function buildListingControlAdminProgram(dependencies?: ListingControlAdminDependencies): Command;
