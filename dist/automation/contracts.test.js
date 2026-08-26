import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUTOMATION_CEILINGS, AUTOMATION_RESPONSIBILITIES, AutomationContractError, buildAutomationPolicy, digestAutomationPolicy, isAutomationResponsibility, MAXIMUM_AUTOMATION_AUTHORIZATION_MS, serializeAutomationPolicy, } from './contracts.js';
const digest = (character) => `sha256:${character.repeat(64)}`;
function validInput(responsibility = 'inventory') {
    const ceiling = AUTOMATION_CEILINGS[responsibility];
    return {
        scopeKey: digest('a'),
        responsibility,
        ownershipVersion: 3,
        cadenceSeconds: ceiling.minimumCadenceSeconds,
        maximumWritesPerRun: ceiling.maximumWritesPerRun,
        maximumWritesPerHour: ceiling.maximumWritesPerHour,
        minimumWriteSpacingMs: ceiling.minimumWriteSpacingMs,
        lightspeedCascadeAccepted: responsibility === 'orderImport',
        activationEvidenceDigest: digest('b'),
        userApprovalEvidenceDigest: digest('c'),
        authorizedAtUtc: '2026-08-26T12:00:00.000Z',
        expiresAtUtc: '2026-09-25T12:00:00.000Z',
    };
}
describe('G18 automation policy contract', () => {
    it('has one fixed four-responsibility allowlist', () => {
        expect(AUTOMATION_RESPONSIBILITIES).toEqual([
            'inventory', 'price', 'orderImport', 'fulfillment',
        ]);
        for (const responsibility of AUTOMATION_RESPONSIBILITIES) {
            expect(isAutomationResponsibility(responsibility)).toBe(true);
        }
        expect(Object.isFrozen(AUTOMATION_RESPONSIBILITIES)).toBe(true);
        expect(Object.isFrozen(AUTOMATION_CEILINGS)).toBe(true);
        expect(AUTOMATION_CEILINGS).toEqual({
            inventory: {
                minimumCadenceSeconds: 60,
                maximumWritesPerRun: 25,
                maximumWritesPerHour: 100,
                minimumWriteSpacingMs: 1_000,
            },
            price: {
                minimumCadenceSeconds: 300,
                maximumWritesPerRun: 10,
                maximumWritesPerHour: 30,
                minimumWriteSpacingMs: 2_000,
            },
            orderImport: {
                minimumCadenceSeconds: 60,
                maximumWritesPerRun: 5,
                maximumWritesPerHour: 5,
                minimumWriteSpacingMs: 10_000,
            },
            fulfillment: {
                minimumCadenceSeconds: 60,
                maximumWritesPerRun: 5,
                maximumWritesPerHour: 20,
                minimumWriteSpacingMs: 10_000,
            },
        });
        for (const denied of [
            'listingCreate', 'listingRevise', 'listingEndRelist', 'mapping',
            'feedback', 'reconciliation', 'orders', 'quantity', '', null, undefined,
        ]) {
            expect(isAutomationResponsibility(denied)).toBe(false);
        }
    });
    it.each(AUTOMATION_RESPONSIBILITIES)('canonicalizes and deterministically digests the bounded %s policy', (responsibility) => {
        const policy = buildAutomationPolicy(validInput(responsibility));
        expect(Object.isFrozen(policy)).toBe(true);
        expect(policy).toEqual({
            schemaVersion: 1,
            decision: 'enable',
            ...validInput(responsibility),
        });
        expect(serializeAutomationPolicy(policy)).toBe(serializeAutomationPolicy(policy));
        expect(digestAutomationPolicy(policy)).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(digestAutomationPolicy(policy)).toBe(digestAutomationPolicy(buildAutomationPolicy({ ...validInput(responsibility) })));
    });
    it('pins the exact canonical bytes and digest for review', () => {
        const policy = buildAutomationPolicy(validInput('inventory'));
        expect(serializeAutomationPolicy(policy)).toBe('{"schemaVersion":1,"decision":"enable","scopeKey":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","responsibility":"inventory","ownershipVersion":3,"cadenceSeconds":60,"maximumWritesPerRun":25,"maximumWritesPerHour":100,"minimumWriteSpacingMs":1000,"lightspeedCascadeAccepted":false,"activationEvidenceDigest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","userApprovalEvidenceDigest":"sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","authorizedAtUtc":"2026-08-26T12:00:00.000Z","expiresAtUtc":"2026-09-25T12:00:00.000Z"}');
        expect(digestAutomationPolicy(policy)).toBe('sha256:de5de6d2ac1a6d619ee69f90a66768525b25d386b9fde9de005d098818711b4f');
        expect(() => serializeAutomationPolicy({
            ...policy,
            unexpectedAuthority: true,
        })).toThrow(AutomationContractError);
    });
    it.each(AUTOMATION_RESPONSIBILITIES)('accepts values below the compiled write ceilings for %s', (responsibility) => {
        expect(buildAutomationPolicy({
            ...validInput(responsibility),
            maximumWritesPerRun: 1,
            maximumWritesPerHour: 1,
            cadenceSeconds: AUTOMATION_CEILINGS[responsibility].minimumCadenceSeconds + 1,
            minimumWriteSpacingMs: AUTOMATION_CEILINGS[responsibility].minimumWriteSpacingMs + 1,
        }).responsibility).toBe(responsibility);
    });
    it.each(AUTOMATION_RESPONSIBILITIES)('denies every compiled ceiling violation for %s', (responsibility) => {
        const ceiling = AUTOMATION_CEILINGS[responsibility];
        const invalid = [
            { cadenceSeconds: ceiling.minimumCadenceSeconds - 1 },
            { maximumWritesPerRun: ceiling.maximumWritesPerRun + 1 },
            { maximumWritesPerHour: ceiling.maximumWritesPerHour + 1 },
            { minimumWriteSpacingMs: ceiling.minimumWriteSpacingMs - 1 },
        ];
        for (const override of invalid) {
            expect(() => buildAutomationPolicy({
                ...validInput(responsibility), ...override,
            })).toThrow(AutomationContractError);
        }
    });
    it('requires explicit Lightspeed cascade acceptance only for order import', () => {
        expect(() => buildAutomationPolicy({
            ...validInput('orderImport'), lightspeedCascadeAccepted: false,
        })).toThrow(AutomationContractError);
        for (const responsibility of ['inventory', 'price', 'fulfillment']) {
            expect(() => buildAutomationPolicy({
                ...validInput(responsibility), lightspeedCascadeAccepted: true,
            })).toThrow(AutomationContractError);
        }
    });
    it('denies noncanonical, nonpositive, overlong, and structurally widened inputs', () => {
        const base = validInput();
        const invalid = [
            null,
            [],
            { ...base, scopeKey: 'sha256:nope' },
            { ...base, activationEvidenceDigest: digest('A') },
            { ...base, userApprovalEvidenceDigest: 'sha256:' },
            { ...base, ownershipVersion: 0 },
            { ...base, ownershipVersion: 1.5 },
            { ...base, cadenceSeconds: 0 },
            { ...base, maximumWritesPerRun: 0 },
            { ...base, maximumWritesPerHour: Number.MAX_SAFE_INTEGER + 1 },
            { ...base, minimumWriteSpacingMs: -1 },
            { ...base, authorizedAtUtc: '2026-08-26T12:00:00Z' },
            { ...base, expiresAtUtc: base.authorizedAtUtc },
            {
                ...base,
                expiresAtUtc: new Date(Date.parse(base.authorizedAtUtc) + MAXIMUM_AUTOMATION_AUTHORIZATION_MS + 1).toISOString(),
            },
            { ...base, unexpectedAuthority: true },
            Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'scopeKey')),
        ];
        for (const value of invalid) {
            expect(() => buildAutomationPolicy(value)).toThrow(AutomationContractError);
        }
    });
    it('does not import runtime, server, CLI, store, credential, or adapter modules', () => {
        const directory = path.dirname(fileURLToPath(import.meta.url));
        const source = [
            fs.readFileSync(path.join(directory, 'contracts.ts'), 'utf8'),
            fs.readFileSync(path.join(directory, 'quarantine.ts'), 'utf8'),
        ].join('\n');
        for (const forbidden of [
            '../server', '../migration-store', '../config', '-admin/', 'adapter',
            'child_process', 'fetch(', 'setInterval(', 'setTimeout(',
        ]) {
            expect(source).not.toContain(forbidden);
        }
    });
});
