export declare function isPlausibleAnthropicKey(key: unknown): key is string;
export type AnthropicConnectionStatus = Readonly<{
    connected: boolean;
    /** 'env' = armed by environment (app cannot disconnect it); 'stored' = vault. */
    source: 'env' | 'stored' | null;
}>;
export declare function readStoredAnthropicKey(): string | null;
/** The one key resolver every AI feature uses: env override, then vault. */
export declare function readAnthropicKey(): {
    key: string;
    source: 'env' | 'stored';
} | null;
export declare function getAnthropicConnectionStatus(): AnthropicConnectionStatus;
/** Live validation: a models list is the cheapest authenticated read. */
export declare function validateAnthropicKey(key: string): Promise<'valid' | 'unauthorized' | 'unreachable'>;
export declare function storeAnthropicKey(key: string): boolean;
export declare function deleteStoredAnthropicKey(): boolean;
