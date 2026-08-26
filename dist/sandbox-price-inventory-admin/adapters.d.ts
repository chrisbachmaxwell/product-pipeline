import { type CredentialPacket, type SandboxAdapter } from '../sandbox-listing-canary-admin/adapter.js';
import { type SandboxEbayState, type SandboxSourceState } from './contracts.js';
export type SandboxAlignmentAdapters = Readonly<{
    readShopifySource: () => Promise<SandboxSourceState>;
    readEbayState: (target: {
        sku: string;
        offerId: string;
        listingId: string;
    }) => Promise<SandboxEbayState>;
    updatePrice: (target: {
        sku: string;
        offerId: string;
    }, price: {
        value: string;
        currency: 'USD';
    }) => Promise<void>;
    updateQuantity: (target: {
        sku: string;
        offerId: string;
    }, quantity: number) => Promise<void>;
}>;
export declare function createSandboxAlignmentAdapters(dependencies?: Readonly<{
    fetchImpl?: typeof fetch;
    databasePath?: string;
    stdin?: NodeJS.ReadableStream;
    now?: () => Date;
    credentialPacket?: CredentialPacket;
    sandboxAdapter?: SandboxAdapter;
}>): Promise<SandboxAlignmentAdapters>;
