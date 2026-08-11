import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEvidencePayload, createEvidenceArtifactSigner, EVIDENCE_SIGNING_KEY_ENV, EvidenceArtifactError, readEvidenceArtifact, verifyEvidenceArtifact, writeEvidenceArtifact, } from '../artifact.js';
import { sha256Digest, } from '../config.js';
const temporaryDirectories = [];
function fixture() {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'product-pipeline-artifact-')));
    temporaryDirectories.push(root);
    const config = {
        schemaVersion: 1,
        project: 'product-pipeline',
        lane: 'production-shadow',
        mode: 'authoritative-read-capture',
        outputDirectory: '.local/evidence-capture',
        identities: {
            shopifyStoreDomain: 'usedcameragear.myshopify.com',
            shopifyShopGid: 'gid://shopify/Shop/1',
            shopifyAppGid: 'gid://shopify/App/2',
            ebayEnvironment: 'production',
            ebayUserId: 'seller-identity',
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
            publicKeySpkiDerBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
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
    const loaded = {
        config,
        repositoryRoot: root,
        configAbsolutePath: path.join(root, 'config/evidence-capture.json'),
        outputDirectoryAbsolutePath: path.join(root, '.local/evidence-capture'),
        scopeDigest: sha256Digest(config.identities),
        configDigest: sha256Digest(config),
    };
    const environment = {
        [EVIDENCE_SIGNING_KEY_ENV]: privateKey
            .export({ format: 'der', type: 'pkcs8' })
            .toString('base64'),
    };
    return { loaded, environment };
}
afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
describe('signed evidence artifacts', () => {
    it('signs, verifies, and writes one immutable 0600 artifact', () => {
        const { loaded, environment } = fixture();
        const payload = buildEvidencePayload({
            loaded,
            source: 'shopify',
            generatedAtUtc: '2026-08-11T20:00:00.000Z',
            externalReadsPerformed: true,
            captureId: '11111111-1111-4111-8111-111111111111',
            evidence: { variants: [{ id: 'gid://shopify/ProductVariant/1', sku: 'SAFE-SKU' }] },
        });
        const signer = createEvidenceArtifactSigner({ loaded, environment });
        const artifact = signer.sign(payload);
        expect(() => verifyEvidenceArtifact({ loaded, artifact })).not.toThrow();
        const written = writeEvidenceArtifact({ loaded, artifact });
        const absolute = path.join(loaded.repositoryRoot, written.relativePath);
        expect(fs.statSync(absolute).mode & 0o777).toBe(0o600);
        expect(fs.statSync(absolute).nlink).toBe(1);
        expect(JSON.parse(fs.readFileSync(absolute, 'utf8'))).toEqual(artifact);
        expect(readEvidenceArtifact({
            loaded,
            requestedArtifactPath: written.relativePath,
        })).toEqual(artifact);
        expect(written.artifactDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
        expect(() => writeEvidenceArtifact({ loaded, artifact })).toThrow(/overwrite is forbidden/);
    });
    it('rejects missing, malformed, wrong-type, and mismatched signing authority', () => {
        const { loaded, environment } = fixture();
        expect(() => createEvidenceArtifactSigner({ loaded, environment: {} })).toThrow(EvidenceArtifactError);
        expect(() => createEvidenceArtifactSigner({
            loaded,
            environment: { [EVIDENCE_SIGNING_KEY_ENV]: 'not-base64' },
        })).toThrow(EvidenceArtifactError);
        const other = generateKeyPairSync('ed25519').privateKey
            .export({ format: 'der', type: 'pkcs8' })
            .toString('base64');
        expect(() => createEvidenceArtifactSigner({
            loaded,
            environment: { [EVIDENCE_SIGNING_KEY_ENV]: other },
        })).toThrow(/does not match/);
        expect(environment[EVIDENCE_SIGNING_KEY_ENV]).not.toBe('');
    });
    it('detects payload and signature tampering', () => {
        const { loaded, environment } = fixture();
        const artifact = createEvidenceArtifactSigner({ loaded, environment }).sign(buildEvidencePayload({
            loaded,
            source: 'ebay',
            generatedAtUtc: '2026-08-11T20:00:00.000Z',
            externalReadsPerformed: true,
            captureId: '22222222-2222-4222-8222-222222222222',
            evidence: { listings: [{ listingId: '123456789012' }] },
        }));
        const tampered = structuredClone(artifact);
        tampered.payload.evidence.listings[0].listingId = '999999999999';
        expect(() => verifyEvidenceArtifact({ loaded, artifact: tampered })).toThrow(EvidenceArtifactError);
        const badSignature = structuredClone(artifact);
        badSignature.signature.valueBase64 = Buffer.alloc(64, 1).toString('base64');
        expect(() => verifyEvidenceArtifact({ loaded, artifact: badSignature })).toThrow(EvidenceArtifactError);
    });
    it('rejects unknown envelope fields even when the payload is correctly re-signed', () => {
        const { loaded, environment } = fixture();
        const signer = createEvidenceArtifactSigner({ loaded, environment });
        const payload = buildEvidencePayload({
            loaded,
            source: 'shopify',
            generatedAtUtc: '2026-08-11T20:00:00.000Z',
            externalReadsPerformed: false,
            captureId: '44444444-4444-4444-8444-444444444444',
            evidence: { status: 'not-collected' },
        });
        payload.unsupported = true;
        const artifact = signer.sign(payload);
        expect(() => verifyEvidenceArtifact({ loaded, artifact })).toThrow(/envelope shape is invalid/);
    });
    it('rejects credential and personal material before signing or writing', () => {
        const { loaded } = fixture();
        expect(() => buildEvidencePayload({
            loaded,
            source: 'shopify',
            generatedAtUtc: '2026-08-11T20:00:00.000Z',
            externalReadsPerformed: false,
            evidence: { accessToken: 'shpat_do-not-write' },
        })).toThrow(EvidenceArtifactError);
        expect(() => buildEvidencePayload({
            loaded,
            source: 'ebay',
            generatedAtUtc: '2026-08-11T20:00:00.000Z',
            externalReadsPerformed: false,
            evidence: { buyer: { email: 'person@example.com' } },
        })).toThrow(EvidenceArtifactError);
        expect(() => buildEvidencePayload({
            loaded,
            source: 'shopify',
            generatedAtUtc: '2026-08-11T20:00:00.000Z',
            externalReadsPerformed: false,
            evidence: { appName: 'debug Bearer abcdefghijklmnop' },
        })).toThrow(EvidenceArtifactError);
        expect(() => buildEvidencePayload({
            loaded,
            source: 'shopify',
            generatedAtUtc: '2026-08-11T20:00:00.000Z',
            externalReadsPerformed: false,
            evidence: { appName: 'Contact person@example.com for access' },
        })).toThrow(EvidenceArtifactError);
    });
    it('refuses a symlinked local output boundary without writing outside', () => {
        const { loaded, environment } = fixture();
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-outside-'));
        temporaryDirectories.push(outside);
        fs.symlinkSync(outside, path.join(loaded.repositoryRoot, '.local'));
        const artifact = createEvidenceArtifactSigner({ loaded, environment }).sign(buildEvidencePayload({
            loaded,
            source: 'shopify',
            generatedAtUtc: '2026-08-11T20:00:00.000Z',
            externalReadsPerformed: false,
            captureId: '33333333-3333-4333-8333-333333333333',
            evidence: { status: 'not-collected' },
        }));
        expect(() => writeEvidenceArtifact({ loaded, artifact })).toThrow(EvidenceArtifactError);
        expect(fs.readdirSync(outside)).toEqual([]);
    });
    it('reads only canonical private single-link artifacts from the fixed directory', () => {
        const { loaded, environment } = fixture();
        const artifact = createEvidenceArtifactSigner({ loaded, environment }).sign(buildEvidencePayload({
            loaded,
            source: 'ebay',
            generatedAtUtc: '2026-08-11T20:00:00.000Z',
            externalReadsPerformed: false,
            captureId: '55555555-5555-4555-8555-555555555555',
            evidence: { status: 'not-collected' },
        }));
        const written = writeEvidenceArtifact({ loaded, artifact });
        const absolute = path.join(loaded.repositoryRoot, written.relativePath);
        const hardlink = path.join(loaded.outputDirectoryAbsolutePath, 'hardlink.json');
        fs.linkSync(absolute, hardlink);
        expect(() => readEvidenceArtifact({
            loaded,
            requestedArtifactPath: written.relativePath,
        })).toThrow(/unavailable or unsafe/);
        fs.unlinkSync(hardlink);
        fs.chmodSync(absolute, 0o644);
        expect(() => readEvidenceArtifact({
            loaded,
            requestedArtifactPath: written.relativePath,
        })).toThrow(/unavailable or unsafe/);
        fs.chmodSync(absolute, 0o600);
        const parsed = JSON.parse(fs.readFileSync(absolute, 'utf8'));
        fs.writeFileSync(absolute, JSON.stringify(parsed), { mode: 0o600 });
        expect(() => readEvidenceArtifact({
            loaded,
            requestedArtifactPath: written.relativePath,
        })).toThrow(/not canonical/);
        expect(() => readEvidenceArtifact({
            loaded,
            requestedArtifactPath: '../outside.json',
        })).toThrow(/fixed local boundary/);
    });
});
