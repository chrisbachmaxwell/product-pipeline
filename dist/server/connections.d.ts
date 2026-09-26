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
export declare function isPlausibleGithubToken(token: unknown): token is string;
export declare function incidentGithubRepo(): string;
/** Env override first, vault second — same contract as the Claude key. */
export declare function readGithubToken(): {
    token: string;
    source: 'env' | 'stored';
} | null;
export declare function getGithubConnectionStatus(): AnthropicConnectionStatus;
/**
 * Live validation: the token must SEE the incident repo. (Issue-write is
 * asked for in the UI instructions; a missing write scope surfaces on the
 * first real escalation and is logged, never silently swallowed.)
 */
export declare function validateGithubToken(token: string): Promise<'valid' | 'unauthorized' | 'unreachable'>;
export declare function storeGithubToken(token: string): boolean;
export declare function deleteStoredGithubToken(): boolean;
