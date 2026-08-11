import { describe, expect, it } from 'vitest';
import { ConfigValidationError, evaluateReadiness, parseOperatorConfig, sha256Digest, } from '../config.js';
import { validConfig } from './fixtures.js';
function denied(config) {
    try {
        parseOperatorConfig(config);
    }
    catch (error) {
        expect(error).toBeInstanceOf(ConfigValidationError);
        return error;
    }
    throw new Error('Expected config to be denied');
}
describe('operator config', () => {
    it('accepts a fully explicit read-only production shadow config', () => {
        const config = parseOperatorConfig(validConfig());
        expect(config.mode).toBe('read-only');
        expect(config.dryRun).toBe(true);
        expect(config.writesEnabled).toBe(false);
        expect(config.orders).toEqual({
            importEnabled: false,
            historicalBackfill: false,
            cutoverWatermarkUtc: null,
        });
        expect(evaluateReadiness(config)).toEqual([]);
        expect(sha256Digest(config)).toMatch(/^sha256:[a-f0-9]{64}$/);
    });
    it.each([
        ['dryRun', { dryRun: false }],
        ['writesEnabled', { writesEnabled: true }],
        ['mode', { mode: 'live' }],
    ])('rejects unsafe %s configuration', (_label, replacement) => {
        const error = denied({ ...validConfig(), ...replacement });
        expect(error.message).toMatch(/must be/);
    });
    it('requires explicit order-import, backfill, and cutover denial', () => {
        const base = validConfig();
        const error = denied({
            ...base,
            orders: {
                importEnabled: true,
                historicalBackfill: true,
                cutoverWatermarkUtc: '2026-08-11T00:00:00.000Z',
            },
        });
        expect(error.issues).toEqual(expect.arrayContaining([
            expect.stringContaining('orders.importEnabled'),
            expect.stringContaining('orders.historicalBackfill'),
            expect.stringContaining('orders.cutoverWatermarkUtc'),
        ]));
    });
    it('rejects ProductPipeline writer ownership outside read-only reconciliation', () => {
        const base = validConfig();
        const error = denied({
            ...base,
            ownership: {
                ...base.ownership,
                inventory: {
                    currentOwner: 'product-pipeline',
                    productPipelineAccess: 'read-only',
                },
            },
        });
        expect(error.message).toContain('ownership.inventory.currentOwner cannot be product-pipeline');
    });
    it('reports unverified ownership as a readiness blocker without enabling writes', () => {
        const base = validConfig();
        const config = parseOperatorConfig({
            ...base,
            ownership: {
                ...base.ownership,
                listingCreate: {
                    currentOwner: 'unverified',
                    productPipelineAccess: 'read-only',
                },
            },
        });
        expect(evaluateReadiness(config)).toEqual([
            'ownership.listingCreate has no verified current owner',
        ]);
        expect(config.writesEnabled).toBe(false);
    });
    it('recursively rejects credential-like keys without echoing their values', () => {
        const base = validConfig();
        const credentialValue = 'do-not-print-this-value';
        const error = denied({
            ...base,
            audit: {
                ...base.audit,
                accessToken: credentialValue,
            },
        });
        expect(error.message).toContain('config.audit.accessToken');
        expect(error.message).not.toContain(credentialValue);
    });
    it('rejects wildcard, blank, and duplicate allowlist entries', () => {
        const base = validConfig();
        const error = denied({
            ...base,
            testLane: {
                ...base.testLane,
                skus: ['TEST-*', ' ', 'TEST-001', 'TEST-001'],
            },
        });
        expect(error.issues).toEqual(expect.arrayContaining([
            expect.stringContaining('without wildcards'),
            expect.stringContaining('non-empty string'),
            expect.stringContaining('duplicates'),
        ]));
    });
    it('rejects unknown fields and lane/environment ambiguity', () => {
        const base = validConfig();
        const error = denied({
            ...base,
            lane: 'sandbox',
            identities: {
                ...base.identities,
                ebayEnvironment: 'production',
            },
            lookbackDays: 90,
        });
        expect(error.issues).toEqual(expect.arrayContaining([
            'config.lookbackDays is not supported',
            expect.stringContaining('ebayEnvironment must be sandbox'),
        ]));
    });
    it('rejects audit paths that escape the repository', () => {
        const base = validConfig();
        const error = denied({
            ...base,
            audit: { logPath: '../operator-audit.jsonl' },
        });
        expect(error.message).toContain('must be exactly');
    });
    it('keeps the Test Lane inactive until an action architecture exists', () => {
        const base = validConfig();
        const error = denied({
            ...base,
            testLane: { ...base.testLane, responsibilities: ['inventory'] },
        });
        expect(error.message).toContain('must remain empty and inactive');
    });
});
