import { type RotatedShopifyAccessToken } from './network.js';
export type ShopifyAuthTokenRow = Readonly<{
    id: number;
    platform: 'shopify';
    accessToken: string;
    refreshToken: null;
    rawScope: string | null;
    scope: string | null;
    expiresAt: null;
    createdAt: number;
    updatedAt: number;
}>;
export type LegacyShopifyTokenStorePathPolicy = Readonly<{
    expectedDatabasePath: string;
    backupDirectory: string;
}>;
export declare class LegacyShopifyTokenStore {
    #private;
    private constructor();
    static open(databasePath: string, pathPolicy?: LegacyShopifyTokenStorePathPolicy): LegacyShopifyTokenStore;
    snapshot(): ShopifyAuthTokenRow;
    createBackup(now: Date): Promise<string>;
    compareAndSwapAccessToken(fresh: RotatedShopifyAccessToken, now: Date): void;
    close(): void;
}
export declare function readShopifyAuthTokenRowReadOnly(databasePath: string, expectedDatabasePath?: string): ShopifyAuthTokenRow;
