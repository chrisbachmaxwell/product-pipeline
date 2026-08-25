import { Command } from 'commander';
import { openMigrationStore } from '../migration-store/index.js';
import { type ShopifyFulfillmentReader } from './shopify-fulfillment-reader.js';
import { type EbayFulfillmentAdapter } from './ebay-fulfillment-adapter.js';
export type FulfillmentTrackingAdminIo = {
    stdout: (message: string) => void;
    stderr: (message: string) => void;
    setExitCode: (code: number) => void;
};
export type FulfillmentTrackingAdminDependencies = Readonly<{
    openMigration?: typeof openMigrationStore;
    shopifyReader?: ShopifyFulfillmentReader;
    ebayAdapter?: EbayFulfillmentAdapter;
    now?: () => Date;
    uuid?: () => string;
    io?: FulfillmentTrackingAdminIo;
}>;
export declare function buildFulfillmentTrackingAdminProgram(dependencies?: FulfillmentTrackingAdminDependencies): Command;
