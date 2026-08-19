import { Command } from 'commander';
import { openMigrationStore } from '../migration-store/index.js';
import { type EbayOrderReadAdapter } from './ebay-order-adapter.js';
import { type ShopifyOrderAdapter } from './shopify-order-adapter.js';
import { openOrderImportStateReader } from './store-reader.js';
export type OrderImportAdminIo = {
    stdout: (message: string) => void;
    stderr: (message: string) => void;
    setExitCode: (code: number) => void;
};
export type OrderImportAdminDependencies = Readonly<{
    openMigration?: typeof openMigrationStore;
    openStateReader?: typeof openOrderImportStateReader;
    createEbayAdapter?: () => EbayOrderReadAdapter;
    createShopifyAdapter?: () => ShopifyOrderAdapter;
    now?: () => Date;
    uuid?: () => string;
    io?: OrderImportAdminIo;
}>;
export declare function buildOrderImportAdminProgram(dependencies?: OrderImportAdminDependencies): Command;
