const SAFE_MESSAGES = {
    'configuration-denied': 'Shadow read configuration was denied.',
    'method-denied': 'Shadow read method was denied.',
    'path-denied': 'Shadow read path was denied.',
    'query-denied': 'Shadow read query was denied.',
    'token-denied': 'Ephemeral read authority was denied.',
    'token-expired': 'Ephemeral read authority is expired.',
    'token-near-expiry': 'Ephemeral read authority is too near expiry.',
    'token-scope-denied': 'Ephemeral read scope was denied.',
    'transport-unavailable': 'No shadow read transport is available.',
    'transport-timeout': 'Shadow read transport timed out.',
    'upstream-failure': 'Shadow read upstream request failed.',
    'upstream-status-denied': 'Shadow read upstream response was denied.',
    'fixture-payload-denied': 'Shadow read fixture payload was denied.',
    'page-cap-exceeded': 'Shadow read page cap was exceeded.',
    'record-cap-exceeded': 'Shadow read record cap was exceeded.',
    'response-byte-cap-exceeded': 'Shadow read response byte cap was exceeded.',
    'pagination-denied': 'Shadow read pagination proof was denied.',
    'order-window-denied': 'Shadow read order window was denied.',
};
/**
 * Public errors intentionally contain only a stable code and a static message.
 * Raw adapter failures, response bodies, URLs, headers, and token material are
 * never attached as a cause or copied into the error.
 */
export class ShadowReadError extends Error {
    code;
    constructor(code) {
        super(SAFE_MESSAGES[code]);
        this.name = 'ShadowReadError';
        this.code = code;
    }
    toJSON() {
        return { name: this.name, code: this.code, message: this.message };
    }
}
export function denyShadowRead(code) {
    throw new ShadowReadError(code);
}
