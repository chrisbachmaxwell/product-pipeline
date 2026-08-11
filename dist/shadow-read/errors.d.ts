export type ShadowReadErrorCode = 'configuration-denied' | 'method-denied' | 'path-denied' | 'query-denied' | 'token-denied' | 'token-expired' | 'token-near-expiry' | 'token-scope-denied' | 'transport-unavailable' | 'transport-timeout' | 'upstream-failure' | 'upstream-status-denied' | 'fixture-payload-denied' | 'page-cap-exceeded' | 'record-cap-exceeded' | 'response-byte-cap-exceeded' | 'pagination-denied' | 'order-window-denied';
/**
 * Public errors intentionally contain only a stable code and a static message.
 * Raw adapter failures, response bodies, URLs, headers, and token material are
 * never attached as a cause or copied into the error.
 */
export declare class ShadowReadError extends Error {
    readonly code: ShadowReadErrorCode;
    constructor(code: ShadowReadErrorCode);
    toJSON(): {
        name: string;
        code: ShadowReadErrorCode;
        message: string;
    };
}
export declare function denyShadowRead(code: ShadowReadErrorCode): never;
