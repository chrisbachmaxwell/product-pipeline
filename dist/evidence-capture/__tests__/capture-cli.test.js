import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildEvidencePayload, createEvidenceArtifactSigner, EVIDENCE_SIGNING_KEY_ENV, writeEvidenceArtifact, } from '../artifact.js';
import { EvidenceCaptureCommandError, runEvidenceCapturePreflight, runEvidenceCollection, verifyLocalEvidenceArtifact, } from '../capture.js';
import { EVIDENCE_CAPTURE_CONFIG_RELATIVE_PATH, loadEvidenceCaptureConfig, sha256Digest, } from '../config.js';
import { createEbayOrderWindow, EBAY_READ_SCOPES } from '../ebay.js';
import { EVIDENCE_AUTHORITY_ENVIRONMENT } from '../network.js';
import { buildEvidenceCaptureProgram, inspectEvidenceCaptureRuntimeBuild, } from '../program.js';
const temporaryDirectories = [];
const NOW = '2026-08-11T20:00:00.000Z';
const START = '2026-08-11T19:00:00.000Z';
const END = '2026-08-11T20:00:00.000Z';
const BUILD = 'a'.repeat(40);
function fixture() {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'product-pipeline-capture-cli-'));
    temporaryDirectories.push(root);
    fs.mkdirSync(path.join(root, 'config'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'product-pipeline' }));
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# test');
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
            ebayUserId: 'immutable-seller-id',
            ebayMarketplaceId: 'EBAY_US',
            ebayRegistrationMarketplaceId: 'EBAY_US',
        },
        collector: {
            name: 'product-pipeline-evidence-capture',
            version: 1,
            buildCommit: BUILD,
        },
        signing: {
            keyId: 'capture-key-v1',
            publicKeySpkiDerBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
        },
        limits: {
            requestTimeoutMs: 15_000,
            maxPagesPerSource: 10,
            maxRecordsPerSource: 100,
            maxResponseBytes: 1024 * 1024,
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
    fs.writeFileSync(path.join(root, EVIDENCE_CAPTURE_CONFIG_RELATIVE_PATH), JSON.stringify(config), { mode: 0o600 });
    const environment = {
        [EVIDENCE_SIGNING_KEY_ENV]: privateKey
            .export({ format: 'der', type: 'pkcs8' }).toString('base64'),
        [EVIDENCE_AUTHORITY_ENVIRONMENT.shopifyAccess]: 'shopify-read-only-value',
        [EVIDENCE_AUTHORITY_ENVIRONMENT.ebayAccess]: 'ebay-read-only-value',
        [EVIDENCE_AUTHORITY_ENVIRONMENT.ebayScopes]: Object.values(EBAY_READ_SCOPES).join(' '),
        [EVIDENCE_AUTHORITY_ENVIRONMENT.ebayIssuedAt]: '2026-08-11T19:30:00.000Z',
        [EVIDENCE_AUTHORITY_ENVIRONMENT.ebayExpiresAt]: '2026-08-11T21:00:00.000Z',
    };
    return {
        root,
        environment,
        runtimeBuild: Object.freeze({ headCommit: BUILD, collectorTreeClean: true }),
    };
}
function shopifyEvidence(orders = []) {
    return {
        schemaVersion: 1,
        kind: 'shopify-authoritative-read-capture',
        identity: {
            shopId: 'gid://shopify/Shop/1',
            storeDomain: 'usedcameragear.myshopify.com',
            appId: 'gid://shopify/App/2',
        },
        variants: [],
        orders,
        provenance: {
            source: 'shopify-admin-graphql',
            apiVersion: '2026-07',
            endpointHost: 'usedcameragear.myshopify.com',
            shopId: 'gid://shopify/Shop/1',
            appId: 'gid://shopify/App/2',
            grantedScopes: ['read_inventory', 'read_orders', 'read_products'],
            observedAtUtc: NOW,
            orderWindow: { startUtc: START, endUtc: END },
            variantPageCount: 1,
            orderPageCount: 1,
            requestCount: 3,
            paginationComplete: true,
            readOnly: true,
            externalWritesPerformed: false,
            historicalBackfillPerformed: false,
        },
    };
}
afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
describe('evidence capture CLI safety surface', () => {
    it('exposes exactly preflight, collect, and verify with no mutation flags', () => {
        const program = buildEvidenceCaptureProgram(undefined, {
            environment: {},
            fetch: vi.fn(),
            now: () => new Date(NOW),
            inspectRuntimeBuild: () => ({ headCommit: BUILD, collectorTreeClean: true }),
        });
        expect(program.commands.map((command) => command.name())).toEqual([
            'preflight',
            'collect',
            'verify',
        ]);
        const optionNames = program.commands.flatMap((command) => command.options.map((option) => option.long));
        expect(optionNames).not.toEqual(expect.arrayContaining([
            '--write', '--live', '--oauth', '--refresh', '--import', '--backfill', '--publish',
        ]));
    });
    it('validates local authority without ever invoking the injected fetch', async () => {
        const { root, environment, runtimeBuild } = fixture();
        const fetch = vi.fn();
        const stdout = [];
        const exits = [];
        const program = buildEvidenceCaptureProgram({
            stdout: (message) => stdout.push(message),
            stderr: (message) => stdout.push(message),
            setExitCode: (code) => exits.push(code),
        }, {
            environment,
            fetch,
            now: () => new Date(NOW),
            inspectRuntimeBuild: () => runtimeBuild,
        });
        await program.parseAsync(['node', 'capture', 'preflight', '--repo-root', root, '--json']);
        expect(fetch).not.toHaveBeenCalled();
        expect(exits).toEqual([]);
        expect(JSON.parse(stdout[0])).toMatchObject({
            command: 'preflight',
            status: 'locally-ready',
            networkPerformed: false,
            remoteAuthorityVerified: false,
            historicalVerificationContextArchived: false,
        });
        expect(stdout.join('\n')).not.toContain('read-only-value');
    });
    it('blocks mismatched or dirty builds before signer construction or fetch', async () => {
        const { root } = fixture();
        const fetch = vi.fn();
        const preflight = runEvidenceCapturePreflight({
            repositoryRoot: root,
            environment: {},
            now: () => new Date(NOW),
            runtimeBuild: { headCommit: 'b'.repeat(40), collectorTreeClean: false },
        });
        expect(preflight.status).toBe('blocked');
        expect(preflight.runtimeBuild).toEqual({
            configuredCommit: BUILD,
            headCommitMatches: false,
            collectorTreeClean: false,
        });
        await expect(runEvidenceCollection({
            repositoryRoot: root,
            environment: {},
            fetch,
            source: 'shopify',
            confirmScopeDigest: 'sha256:' + '0'.repeat(64),
            orderStartUtc: START,
            orderEndUtc: END,
            now: () => new Date(NOW),
            runtimeBuild: { headCommit: 'b'.repeat(40), collectorTreeClean: true },
        })).rejects.toMatchObject({ code: 'build-identity-denied' });
        expect(fetch).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(root, '.local'))).toBe(false);
    });
    it('validates the repository before fixed Git inspection and gives Git no authority environment', () => {
        const { root } = fixture();
        const calls = [];
        const execute = vi.fn((executable, arguments_, options) => {
            calls.push({ executable, arguments_, environment: options.env });
            return arguments_.includes('rev-parse') ? `${BUILD}\n` : '';
        });
        expect(inspectEvidenceCaptureRuntimeBuild(root, execute)).toEqual({
            headCommit: BUILD,
            collectorTreeClean: true,
        });
        expect(calls).toHaveLength(2);
        for (const call of calls) {
            expect(call.executable).toBe('/usr/bin/git');
            expect(call.arguments_).toEqual(expect.arrayContaining([
                '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
            ]));
            expect(call.environment).toEqual({ LANG: 'C', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' });
            expect(Object.keys(call.environment ?? {})).not.toEqual(expect.arrayContaining([
                EVIDENCE_AUTHORITY_ENVIRONMENT.shopifyAccess,
                EVIDENCE_AUTHORITY_ENVIRONMENT.ebayAccess,
                EVIDENCE_AUTHORITY_ENVIRONMENT.ebayScopes,
                EVIDENCE_SIGNING_KEY_ENV,
            ]));
        }
        expect(() => inspectEvidenceCaptureRuntimeBuild(path.join(root, 'missing'), execute)).toThrow();
        expect(execute).toHaveBeenCalledTimes(2);
    });
    it('rejects an invalid scope confirmation and noncanonical or historical windows before fetch', async () => {
        const { root, runtimeBuild } = fixture();
        const fetch = vi.fn();
        await expect(runEvidenceCollection({
            repositoryRoot: root,
            environment: {},
            fetch,
            source: 'shopify',
            confirmScopeDigest: 'sha256:' + '0'.repeat(64),
            orderStartUtc: START,
            orderEndUtc: END,
            now: () => new Date(NOW),
            runtimeBuild,
        })).rejects.toMatchObject({ code: 'scope-confirmation-denied' });
        const loaded = loadEvidenceCaptureConfig({
            repositoryRoot: root,
            requestedConfigPath: EVIDENCE_CAPTURE_CONFIG_RELATIVE_PATH,
        });
        await expect(runEvidenceCollection({
            repositoryRoot: root,
            environment: {},
            fetch,
            source: 'ebay',
            confirmScopeDigest: loaded.scopeDigest,
            orderStartUtc: '2026-08-01T00:00:00.000Z',
            orderEndUtc: END,
            now: () => new Date(NOW),
            runtimeBuild,
        })).rejects.toMatchObject({ code: 'window-denied' });
        expect(fetch).not.toHaveBeenCalled();
    });
    it('verifies durable signatures while classifying freshness and rejecting half-open boundary violations', () => {
        const { root, environment, runtimeBuild } = fixture();
        const loaded = loadEvidenceCaptureConfig({
            repositoryRoot: root,
            requestedConfigPath: EVIDENCE_CAPTURE_CONFIG_RELATIVE_PATH,
        });
        const signer = createEvidenceArtifactSigner({ loaded, environment });
        const valid = signer.sign(buildEvidencePayload({
            loaded,
            source: 'shopify',
            evidence: shopifyEvidence(),
            generatedAtUtc: NOW,
            externalReadsPerformed: true,
        }));
        const written = writeEvidenceArtifact({ loaded, artifact: valid });
        expect(verifyLocalEvidenceArtifact({
            repositoryRoot: root,
            requestedArtifactPath: written.relativePath,
            now: () => new Date('2026-08-11T20:05:00.000Z'),
            runtimeBuild,
        })).toMatchObject({
            status: 'verified',
            freshness: 'fresh',
            currentReadEvidence: true,
            parityUseAllowed: false,
        });
        expect(verifyLocalEvidenceArtifact({
            repositoryRoot: root,
            requestedArtifactPath: written.relativePath,
            now: () => new Date('2026-08-12T20:00:00.000Z'),
            runtimeBuild,
        })).toMatchObject({
            status: 'verified',
            freshness: 'stale',
            currentReadEvidence: false,
        });
        const boundaryOrder = {
            orderId: 'gid://shopify/Order/99',
            createdAtUtc: END,
            updatedAtUtc: END,
            app: null,
            sourceName: 'ebay',
            sourceIdentifier: 'order-99',
            financialStatus: null,
            fulfillmentStatus: 'UNFULFILLED',
            test: true,
        };
        const invalid = signer.sign(buildEvidencePayload({
            loaded,
            source: 'shopify',
            evidence: shopifyEvidence([boundaryOrder]),
            generatedAtUtc: NOW,
            externalReadsPerformed: true,
        }));
        const invalidWritten = writeEvidenceArtifact({ loaded, artifact: invalid });
        expect(() => verifyLocalEvidenceArtifact({
            repositoryRoot: root,
            requestedArtifactPath: invalidWritten.relativePath,
            now: () => new Date(NOW),
            runtimeBuild,
        })).toThrow(EvidenceCaptureCommandError);
    });
    it('round-trips nonempty canonical eBay evidence with an explicit end before capture time', () => {
        const { root, environment, runtimeBuild } = fixture();
        const loaded = loadEvidenceCaptureConfig({
            repositoryRoot: root,
            requestedConfigPath: EVIDENCE_CAPTURE_CONFIG_RELATIVE_PATH,
        });
        const endUtc = '2026-08-11T19:55:00.000Z';
        expect(createEbayOrderWindow({ startUtc: START, endUtc, asOfUtc: NOW })).toMatchObject({
            startUtc: START,
            endUtc,
            asOfUtc: NOW,
            historicalBackfill: false,
        });
        const inventoryRecords = {
            inventoryItems: [{
                    sku: 'SAFE-SKU-1',
                    locale: 'en_US',
                    condition: 'USED_EXCELLENT',
                    inventoryItemGroupKeys: [],
                    shipToLocationQuantity: 1,
                }],
            offers: [{
                    offerId: 'offer-1',
                    sku: 'SAFE-SKU-1',
                    marketplaceId: 'EBAY_US',
                    format: 'FIXED_PRICE',
                    status: 'PUBLISHED',
                    availableQuantity: 1,
                    categoryId: '31388',
                    price: { currency: 'USD', value: '125.00' },
                    listing: {
                        listingId: 'listing-1',
                        listingStatus: 'ACTIVE',
                        soldQuantity: 0,
                        listingOnHold: false,
                    },
                }],
        };
        const orderRecords = [{
                orderId: 'ebay-order-1',
                creationDate: '2026-08-11T19:30:00.000Z',
                lastModifiedDate: '2026-08-11T19:40:00.000Z',
                orderFulfillmentStatus: 'NOT_STARTED',
            }];
        const session = { kind: 'direct-ebay-api', captureSessionId: 'session-1' };
        const identity = { userId: 'immutable-seller-id', registrationMarketplaceId: 'EBAY_US' };
        const evidence = {
            schemaVersion: 1,
            kind: 'ebay-authoritative-read-capture',
            identity,
            inventory: {
                complete: true,
                evidenceMode: 'direct-ebay-api',
                transportProvenance: session,
                environment: 'production',
                capturedAtUtc: NOW,
                identity,
                coverage: {
                    model: 'ebay-inventory-api-records-and-associated-offers-only',
                    allSellerListingsClaimed: false,
                    tradingApiListingsIncluded: false,
                    activeInventoryReportUsed: false,
                },
                safeguards: {
                    getOnly: true,
                    oauthRefreshAbsent: true,
                    externalWritesSupported: false,
                },
                records: inventoryRecords,
                requests: [
                    { method: 'GET', host: 'apiz.ebay.com', path: '/commerce/identity/v1/user/', requiredScope: EBAY_READ_SCOPES.identity },
                    { method: 'GET', host: 'api.ebay.com', path: '/sell/inventory/v1/inventory_item', requiredScope: EBAY_READ_SCOPES.inventory },
                    { method: 'GET', host: 'api.ebay.com', path: '/sell/inventory/v1/offer', requiredScope: EBAY_READ_SCOPES.inventory },
                ],
                responseBytes: 512,
                recordDigest: sha256Digest(inventoryRecords),
            },
            orders: {
                complete: true,
                evidenceMode: 'direct-ebay-api',
                transportProvenance: session,
                environment: 'production',
                capturedAtUtc: NOW,
                identity,
                coverage: {
                    model: 'ebay-fulfillment-completed-checkout-orders',
                    window: {
                        startUtc: START,
                        endUtc,
                        lowerBoundInclusive: true,
                        upperBoundExclusive: true,
                        ebayQueryUpperBoundIsInclusive: true,
                        upperBoundaryPostFiltered: true,
                    },
                    historicalBackfill: false,
                    cutoverWatermark: false,
                },
                safeguards: {
                    getOnly: true,
                    oauthRefreshAbsent: true,
                    externalWritesSupported: false,
                    orderFieldsMinimized: true,
                },
                records: orderRecords,
                inclusiveRecordCount: 1,
                requests: [
                    { method: 'GET', host: 'apiz.ebay.com', path: '/commerce/identity/v1/user/', requiredScope: EBAY_READ_SCOPES.identity },
                    { method: 'GET', host: 'api.ebay.com', path: '/sell/fulfillment/v1/order', requiredScope: EBAY_READ_SCOPES.fulfillment },
                ],
                responseBytes: 256,
                recordDigest: sha256Digest(orderRecords),
            },
        };
        const artifact = createEvidenceArtifactSigner({ loaded, environment }).sign(buildEvidencePayload({
            loaded,
            source: 'ebay',
            evidence,
            generatedAtUtc: NOW,
            externalReadsPerformed: true,
        }));
        const written = writeEvidenceArtifact({ loaded, artifact });
        expect(verifyLocalEvidenceArtifact({
            repositoryRoot: root,
            requestedArtifactPath: written.relativePath,
            now: () => new Date('2026-08-11T20:05:00.000Z'),
            runtimeBuild,
        })).toMatchObject({
            source: 'ebay',
            freshness: 'fresh',
            counts: { primary: 1, secondary: 1, orders: 1 },
            signatureValid: true,
            sourceSchemaValid: true,
            parityUseAllowed: false,
        });
    });
    it('keeps the capture entrypoint isolated from legacy commerce runtime imports', () => {
        const root = path.resolve(import.meta.dirname, '..');
        const sources = ['capture.ts', 'program.ts', 'index.ts']
            .map((filename) => fs.readFileSync(path.join(root, filename), 'utf8'))
            .join('\n');
        expect(sources).not.toMatch(/from ['"]\.\.\/(?:server|db|cli|operator-cli|migration-admin)\//);
        expect(sources).not.toMatch(/from ['"]\.\/(?:sync|orders?|listings?|webhooks?|scheduler)\b/);
        expect(sources).not.toMatch(/\b(?:mutation|orderCreate|inventoryAdjust|publishOffer)\b/);
    });
});
