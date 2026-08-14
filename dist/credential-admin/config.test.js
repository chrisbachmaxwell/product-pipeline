import { describe, expect, it, vi } from 'vitest';
import { PRODUCT_PIPELINE_SHOPIFY_IDENTITY } from '../shopify/production-identity.js';
import { assertShopifyCredentialRotationAuthorizationActive, assertShopifyCredentialRotationDispatchAuthorized, loadShopifyCredentialRotationConfig, PRODUCT_PIPELINE_PRODUCTION_RUNTIME, SHOPIFY_CREDENTIAL_ROTATION_CONFIG_LIMITS, } from './config.js';
const NOW = Date.parse('2026-08-14T18:00:00.000Z');
function environment(overrides = {}) {
    return {
        NODE_ENV: 'production',
        RAILWAY_PROJECT_ID: PRODUCT_PIPELINE_PRODUCTION_RUNTIME.projectId,
        RAILWAY_ENVIRONMENT_ID: PRODUCT_PIPELINE_PRODUCTION_RUNTIME.environmentId,
        RAILWAY_SERVICE_ID: PRODUCT_PIPELINE_PRODUCTION_RUNTIME.serviceId,
        DATABASE_PATH: PRODUCT_PIPELINE_PRODUCTION_RUNTIME.databasePath,
        SHOPIFY_CLIENT_ID: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.clientId,
        SHOPIFY_CLIENT_SECRET: 'new-production-client-secret',
        SHOPIFY_PREVIOUS_CLIENT_SECRET: 'old-production-client-secret',
        SHOPIFY_PREVIOUS_CLIENT_SECRET_EXPIRES_AT_UTC: '2026-08-14T18:45:00.000Z',
        SHOPIFY_ROTATION_REFRESH_TOKEN: 'temporary-dashboard-refresh-token',
        SHOPIFY_CREDENTIAL_ROTATION_SINGLE_WRITER_ACK: PRODUCT_PIPELINE_PRODUCTION_RUNTIME.singleWriterAck,
        SHOPIFY_CREDENTIAL_ROTATION_SINGLE_WRITER_ACK_EXPIRES_AT_UTC: '2026-08-14T18:30:00.000Z',
        ...overrides,
    };
}
function load(overrides = {}, requireRefreshToken = true) {
    return loadShopifyCredentialRotationConfig({
        environment: environment(overrides),
        now: NOW,
        requireRefreshToken,
        validateDatabasePath: vi.fn(),
    });
}
describe('Shopify credential rotation Production binding', () => {
    it('pins the exact project, environment, service, database, store, and client', () => {
        expect(load()).toEqual({
            databasePath: '/data/ebaysync.db',
            clientId: PRODUCT_PIPELINE_SHOPIFY_IDENTITY.clientId,
            clientSecret: 'new-production-client-secret',
            previousClientSecret: 'old-production-client-secret',
            previousClientSecretExpiresAtEpochMs: Date.parse('2026-08-14T18:45:00.000Z'),
            refreshToken: 'temporary-dashboard-refresh-token',
            storeDomain: 'usedcameragear.myshopify.com',
            authorizationExpiresAtEpochMs: Date.parse('2026-08-14T18:30:00.000Z'),
        });
        expect(load({
            SHOPIFY_ROTATION_REFRESH_TOKEN: undefined,
            SHOPIFY_PREVIOUS_CLIENT_SECRET: undefined,
            SHOPIFY_PREVIOUS_CLIENT_SECRET_EXPIRES_AT_UTC: undefined,
        }, false)).toMatchObject({
            refreshToken: null,
            previousClientSecret: null,
            previousClientSecretExpiresAtEpochMs: null,
        });
    });
    it.each([
        { NODE_ENV: undefined },
        { NODE_ENV: 'development' },
        { RAILWAY_PROJECT_ID: 'wrong' },
        { RAILWAY_ENVIRONMENT_ID: 'wrong' },
        { RAILWAY_SERVICE_ID: 'wrong' },
        { DATABASE_PATH: '/data/other.db' },
        { SHOPIFY_CLIENT_ID: 'wrong-client-id-value' },
        { SHOPIFY_CLIENT_SECRET: undefined },
        { SHOPIFY_PREVIOUS_CLIENT_SECRET: undefined },
        { SHOPIFY_PREVIOUS_CLIENT_SECRET_EXPIRES_AT_UTC: undefined },
        { SHOPIFY_PREVIOUS_CLIENT_SECRET: 'new-production-client-secret' },
        { SHOPIFY_PREVIOUS_CLIENT_SECRET_EXPIRES_AT_UTC: '2026-08-14T18:14:59.999Z' },
        { SHOPIFY_PREVIOUS_CLIENT_SECRET_EXPIRES_AT_UTC: '2026-08-14T19:00:00.001Z' },
        { SHOPIFY_ROTATION_REFRESH_TOKEN: undefined },
        { SHOPIFY_CREDENTIAL_ROTATION_SINGLE_WRITER_ACK: 'wrong' },
        { LISTING_CONTROL_SINGLE_WRITER_ACK: '' },
        { LISTING_CONTROL_SINGLE_WRITER_ACK: 'product-pipeline-local-draft-v1' },
    ])('rejects a mismatched or ambiguous binding %#', (overrides) => {
        expect(() => load(overrides)).toThrow(expect.objectContaining({
            code: 'configuration-denied',
            message: 'Shopify credential rotation failed closed',
        }));
    });
    it.each([
        'not-a-date',
        '2026-08-14T17:59:59.999Z',
        '2026-08-14T18:00:00.000Z',
        new Date(NOW + SHOPIFY_CREDENTIAL_ROTATION_CONFIG_LIMITS.maximumAckLifetimeMs + 1)
            .toISOString(),
    ])('rejects invalid, expired, or overlong ACK deadline %s', (deadline) => {
        expect(() => load({
            SHOPIFY_CREDENTIAL_ROTATION_SINGLE_WRITER_ACK_EXPIRES_AT_UTC: deadline,
        })).toThrow(expect.objectContaining({ code: 'configuration-denied' }));
    });
    it('revalidates the carried authorization at the exact dispatch/CAS cutoff', () => {
        const loaded = load();
        expect(() => assertShopifyCredentialRotationAuthorizationActive(loaded, loaded.authorizationExpiresAtEpochMs - 1)).not.toThrow();
        expect(() => assertShopifyCredentialRotationAuthorizationActive(loaded, loaded.authorizationExpiresAtEpochMs)).toThrow(expect.objectContaining({ code: 'configuration-denied' }));
    });
    it('requires both ACK and old/new verifier overlap to retain the fixed dispatch window', () => {
        const loaded = load();
        const minimum = SHOPIFY_CREDENTIAL_ROTATION_CONFIG_LIMITS.minimumRotationDispatchWindowMs;
        expect(() => assertShopifyCredentialRotationDispatchAuthorized(loaded, Math.min(loaded.authorizationExpiresAtEpochMs, loaded.previousClientSecretExpiresAtEpochMs ?? 0) - minimum)).not.toThrow();
        expect(() => assertShopifyCredentialRotationDispatchAuthorized(loaded, loaded.authorizationExpiresAtEpochMs - minimum + 1)).toThrow(expect.objectContaining({ code: 'configuration-denied' }));
    });
});
