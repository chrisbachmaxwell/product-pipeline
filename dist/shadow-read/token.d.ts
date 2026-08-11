export type ReadProvider = 'shopify' | 'ebay';
export type EphemeralReadTokenInput = Readonly<{
    provider: ReadProvider;
    accessToken: string;
    issuedAtUtc: string;
    expiresAtUtc: string;
    scopes: readonly string[];
}>;
export type EphemeralReadTokenPolicy = Readonly<{
    provider: ReadProvider;
    allowedScopes: readonly string[];
    minimumRemainingValidityMs: number;
    maximumLifetimeMs: number;
}>;
export type ValidatedEphemeralReadToken = Readonly<{
    kind: 'validated-ephemeral-read-token';
    provider: ReadProvider;
    issuedAtUtc: string;
    expiresAtUtc: string;
    scopes: readonly string[];
    toJSON: () => Readonly<{
        kind: 'validated-ephemeral-read-token';
        provider: ReadProvider;
        issuedAtUtc: string;
        expiresAtUtc: string;
        scopes: readonly string[];
        secret: '[REDACTED]';
    }>;
}>;
export declare const KNOWN_READ_SCOPES: Readonly<{
    shopify: readonly string[];
    ebay: readonly string[];
}>;
/**
 * Validates only explicitly supplied token material. This module has no token
 * acquisition, refresh, environment, file, database, or network behavior.
 */
export declare function validateEphemeralReadToken(rawToken: unknown, rawPolicy: unknown, nowUtc: string): ValidatedEphemeralReadToken;
/**
 * Narrow adapter seam used by the injected transport. It re-checks expiry and
 * exact scopes immediately before a request and has no refresh fallback.
 */
export declare function assertEphemeralReadAuthorizedForTransport(token: ValidatedEphemeralReadToken, provider: ReadProvider, requiredScopes: readonly string[], nowUtc: string): void;
