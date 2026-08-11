import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EVIDENCE_CAPTURE_CONFIG_RELATIVE_PATH, EvidenceCaptureConfigError, loadEvidenceCaptureConfig, parseEvidenceCaptureConfig, } from '../config.js';
const temporaryDirectories = [];
function publicKeyBase64() {
    const { publicKey } = generateKeyPairSync('ed25519');
    return publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
}
function validConfig() {
    return {
        schemaVersion: 1,
        project: 'product-pipeline',
        lane: 'production-shadow',
        mode: 'authoritative-read-capture',
        outputDirectory: '.local/evidence-capture',
        identities: {
            shopifyStoreDomain: 'usedcameragear.myshopify.com',
            shopifyShopGid: 'gid://shopify/Shop/1234',
            shopifyAppGid: 'gid://shopify/App/5678',
            ebayEnvironment: 'production',
            ebayUserId: 'immutable-seller-123',
            ebayMarketplaceId: 'EBAY_US',
            ebayRegistrationMarketplaceId: 'EBAY_US',
        },
        collector: {
            name: 'product-pipeline-evidence-capture',
            version: 1,
            buildCommit: 'a'.repeat(40),
        },
        signing: {
            keyId: 'capture-key-v1',
            publicKeySpkiDerBase64: publicKeyBase64(),
        },
        limits: {
            requestTimeoutMs: 15_000,
            maxPagesPerSource: 100,
            maxRecordsPerSource: 10_000,
            maxResponseBytes: 4 * 1024 * 1024,
            minimumEbayAccessValiditySeconds: 900,
            maxOrderWindowHours: 168,
        },
        safety: {
            externalPlatformReads: true,
            externalPlatformWrites: false,
            historicalBackfill: false,
            oauthAcquisition: false,
            accessRefresh: false,
            rawPayloadPersistence: false,
            personalDataPersistence: false,
            cutoverWatermarkUtc: null,
            ownershipTransferAllowed: false,
        },
    };
}
function makeRepository() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-pipeline-evidence-config-'));
    temporaryDirectories.push(root);
    fs.mkdirSync(path.join(root, 'config'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'product-pipeline' }));
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# test');
    return root;
}
afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
describe('evidence capture configuration', () => {
    it('accepts only the explicit shadow read contract', () => {
        const parsed = parseEvidenceCaptureConfig(validConfig());
        expect(parsed.lane).toBe('production-shadow');
        expect(parsed.identities.ebayEnvironment).toBe('production');
        expect(parsed.safety).toEqual({
            externalPlatformReads: true,
            externalPlatformWrites: false,
            historicalBackfill: false,
            oauthAcquisition: false,
            accessRefresh: false,
            rawPayloadPersistence: false,
            personalDataPersistence: false,
            cutoverWatermarkUtc: null,
            ownershipTransferAllowed: false,
        });
    });
    it.each([
        ['externalPlatformWrites', true],
        ['historicalBackfill', true],
        ['oauthAcquisition', true],
        ['accessRefresh', true],
        ['rawPayloadPersistence', true],
        ['personalDataPersistence', true],
        ['ownershipTransferAllowed', true],
        ['cutoverWatermarkUtc', '2026-08-11T00:00:00.000Z'],
    ])('rejects unsafe safety setting %s', (key, value) => {
        const config = validConfig();
        Object.assign(config.safety, { [key]: value });
        expect(() => parseEvidenceCaptureConfig(config)).toThrow(EvidenceCaptureConfigError);
    });
    it('rejects unknown and credential-bearing fields without echoing values', () => {
        const config = validConfig();
        config.nested = { accessToken: 'shpat_do-not-echo-this-value' };
        try {
            parseEvidenceCaptureConfig(config);
            throw new Error('expected rejection');
        }
        catch (error) {
            expect(error).toBeInstanceOf(EvidenceCaptureConfigError);
            expect(String(error)).not.toContain('do-not-echo');
            expect(String(error)).not.toContain('accessToken');
        }
    });
    it('rejects lane/account mismatches, placeholders, and malformed keys', () => {
        const sandboxMismatch = validConfig();
        sandboxMismatch.lane = 'sandbox';
        expect(() => parseEvidenceCaptureConfig(sandboxMismatch)).toThrow(EvidenceCaptureConfigError);
        const placeholder = validConfig();
        placeholder.identities.ebayUserId = 'replace-with-user-id';
        expect(() => parseEvidenceCaptureConfig(placeholder)).toThrow(EvidenceCaptureConfigError);
        const malformedPublicKey = validConfig();
        malformedPublicKey.signing.publicKeySpkiDerBase64 = Buffer.from('not-ed25519').toString('base64');
        expect(() => parseEvidenceCaptureConfig(malformedPublicKey)).toThrow(EvidenceCaptureConfigError);
        const shippedExample = JSON.parse(fs.readFileSync(path.resolve('config/evidence-capture.example.json'), 'utf8'));
        expect(() => parseEvidenceCaptureConfig(shippedExample)).toThrow(EvidenceCaptureConfigError);
    });
    it('loads only the fixed repository-local regular file and derives digests', () => {
        const root = makeRepository();
        const configPath = path.join(root, EVIDENCE_CAPTURE_CONFIG_RELATIVE_PATH);
        fs.writeFileSync(configPath, JSON.stringify(validConfig()), { mode: 0o600 });
        const loaded = loadEvidenceCaptureConfig({
            repositoryRoot: root,
            requestedConfigPath: EVIDENCE_CAPTURE_CONFIG_RELATIVE_PATH,
        });
        expect(loaded.config.identities.shopifyStoreDomain).toBe('usedcameragear.myshopify.com');
        expect(loaded.scopeDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(loaded.configDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(loaded.outputDirectoryAbsolutePath).toBe(path.join(fs.realpathSync(root), '.local/evidence-capture'));
    });
    it('rejects alternate paths, symlinked files, and symlinked output ancestors', () => {
        const root = makeRepository();
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-config-outside-'));
        temporaryDirectories.push(outside);
        fs.writeFileSync(path.join(outside, 'config.json'), JSON.stringify(validConfig()));
        fs.symlinkSync(path.join(outside, 'config.json'), path.join(root, EVIDENCE_CAPTURE_CONFIG_RELATIVE_PATH));
        expect(() => loadEvidenceCaptureConfig({
            repositoryRoot: root,
            requestedConfigPath: EVIDENCE_CAPTURE_CONFIG_RELATIVE_PATH,
        })).toThrow(EvidenceCaptureConfigError);
        expect(() => loadEvidenceCaptureConfig({
            repositoryRoot: root,
            requestedConfigPath: 'config/other.json',
        })).toThrow(EvidenceCaptureConfigError);
        fs.rmSync(path.join(root, EVIDENCE_CAPTURE_CONFIG_RELATIVE_PATH));
        fs.writeFileSync(path.join(root, EVIDENCE_CAPTURE_CONFIG_RELATIVE_PATH), JSON.stringify(validConfig()));
        fs.symlinkSync(outside, path.join(root, '.local'));
        expect(() => loadEvidenceCaptureConfig({
            repositoryRoot: root,
            requestedConfigPath: EVIDENCE_CAPTURE_CONFIG_RELATIVE_PATH,
        })).toThrow(EvidenceCaptureConfigError);
    });
});
