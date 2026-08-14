import { type Shopify } from '@shopify/shopify-api';
import '@shopify/shopify-api/adapters/node';
import { type ShopifyCredentials } from '../config/credentials.js';
type Timer = ReturnType<typeof setTimeout>;
export type ShopifyClientCredentialsTokenDependencies = Readonly<{
    fetchImpl?: typeof fetch;
    loadCredentials?: () => Promise<ShopifyCredentials>;
    scheduleTimeout?: (callback: () => void, milliseconds: number) => Timer;
    clearScheduledTimeout?: (timer: Timer) => void;
}>;
export declare const createShopifyApi: () => Promise<Shopify>;
export declare const createShopifyGraphqlClient: (accessToken: string) => Promise<import("@shopify/shopify-api").GraphqlClient>;
export declare const requestShopifyClientCredentialsToken: (dependencies?: ShopifyClientCredentialsTokenDependencies) => Promise<string>;
export declare const SHOPIFY_CLIENT_CREDENTIALS_TOKEN_LIMITS: Readonly<{
    requestTimeoutMs: 10000;
    responseMaxBytes: number;
}>;
export {};
