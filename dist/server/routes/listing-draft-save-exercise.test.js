/**
 * G3 goal-board exercise: drive one authenticated bounded local draft append
 * through the exact mounted middleware chain — real rate limiter, real
 * Shopify App Bridge HS256 session verification for the pinned store, real
 * writer-quarantine middleware, real bounded JSON parser, real service, and a
 * real on-disk listing-control store initialized and verified by the real
 * `listing-control-admin` program.
 *
 * The only substituted dependency is the live workspace read
 * (`readWorkspace`), because a live Shopify/eBay capture requires production
 * credentials that must never enter this repository or its tests. The
 * session-signing secret is a random local value used to exercise the real
 * verification code path; no production credential is involved and no
 * provider request of any kind is made.
 *
 * When LISTING_DRAFT_EXERCISE_TRANSCRIPT_TARGET names a writable path, the
 * run writes a redacted JSON transcript so an operator can retain the proof.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writerQuarantineMiddleware } from '../../safety/writer-quarantine.js';
import { PRODUCT_PIPELINE_SHOPIFY_IDENTITY } from '../../shopify/production-identity.js';
import { buildListingControlAdminProgram } from '../../listing-control-admin/program.js';
import { openListingControlStoreReadOnly, } from '../../listing-control-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../../listing-control-config.js';
import { apiKeyAuth, rateLimit } from '../middleware/auth.js';
import { createListingDraftService } from '../listing-draft-service.js';
import { LISTING_DRAFT_ROUTE_TESTING, createListingDraftRouter, listingDraftJsonErrorHandler, listingDraftJsonParser, } from './listing-drafts.js';
const EXERCISE_SUBJECT = 'g3-exercise-operator';
const CATALOG_ID = 'shopify-variant:gid://shopify/ProductVariant/55396000563491';
const VARIANT_GID = 'gid://shopify/ProductVariant/55396000563491';
const ENVIRONMENT_KEYS = [
    'NODE_ENV', 'TEST_MODE', 'API_KEY', 'ALLOW_OPERATOR_API_KEY',
    'SHOPIFY_CLIENT_ID', 'SHOPIFY_CLIENT_SECRET',
    'SHOPIFY_PREVIOUS_CLIENT_SECRET', 'SHOPIFY_PREVIOUS_CLIENT_SECRET_EXPIRES_AT_UTC',
    'LISTING_CONTROL_DATABASE_PATH', 'LISTING_CONTROL_SINGLE_WRITER_ACK',
];
const savedEnvironment = new Map();
const servers = [];
let root = '';
let databasePath = '';
let localSessionSecret = '';
function workspace(options = {}) {
    const productId = 'gid://shopify/Product/10310708035875';
    const sku = 'CAN3570-U119';
    const listingId = '147502608418';
    const offerId = '234942877011';
    return {
        schemaVersion: 1,
        evidence: {
            catalogObservedAtUtc: '2026-08-13T21:59:00.000Z',
            detailObservedAtUtc: '2026-08-13T22:00:01.000Z',
            freshness: 'live', backgroundRefreshSeconds: 60,
            remoteReadPerformed: true, externalWritesPerformed: 0,
        },
        catalog: {
            id: CATALOG_ID,
            shopify: {
                productId, variantId: VARIANT_GID, sku, title: 'Shopify New', variantTitle: 'Default',
                productStatus: 'ACTIVE', primaryImageUrl: null, imageCount: 1, available: 1,
                price: { amount: '39.95', currency: 'USD' },
            },
            ebay: {
                sku, state: 'active', listingId, offerId,
                url: `https://www.ebay.com/itm/${listingId}`,
                activeMatchCount: 1, inventoryItemCount: 1,
                offerCount: 1, unpublishedArtifactCount: 0,
            },
            lifecycleStatus: 'active',
            lastVerifiedAtUtc: '2026-08-13T21:59:00.000Z',
            audit: { verified: true, evidenceState: 'live_verified', unresolvedCount: 0,
                attentionReasons: [], recoverySupported: false, currentRemoteStateVerified: true },
        },
        mapping: {
            state: 'mapped', joinKey: 'exact_raw_sku',
            shopifyProductId: productId, shopifyVariantId: VARIANT_GID,
            inventorySku: sku, offerId, listingId,
            managementModel: 'inventory_offer',
            ownership: { listing: 'unverified', mapping: 'unverified',
                price: 'marketplace_connect', inventory: 'marketplace_connect' },
            editMode: 'read_only',
        },
        ebayDetail: {
            schemaVersion: 1,
            evidence: { source: 'ebay-trading-get-item+ebay-inventory-detail',
                observedAtUtc: '2026-08-13T22:00:01.000Z', complete: true,
                remoteReadPerformed: true, externalWritesPerformed: 0, requestCount: 4 },
            identity: { sellerId: 'usedcameragear', marketplaceId: 'EBAY_US', mappingState: 'mapped',
                shopifyProductId: productId, shopifyVariantId: VARIANT_GID, sku, listingId,
                publicListingUrl: `https://www.ebay.com/itm/${listingId}`, offerId },
            actual: {
                lifecycle: { status: 'ACTIVE', active: true, format: 'FIXED_PRICE', duration: 'GTC',
                    startAtUtc: null, endAtUtc: null },
                content: { title: options.ebayTitle ?? 'eBay Old',
                    descriptionHtml: '<p>Safe &amp; clean</p>',
                    imageUrls: ['https://i.ebayimg.com/images/g/abc/s-l1600.jpg'] },
                category: { primary: { id: '3323', name: 'Lenses' }, secondary: null, storeCategories: [] },
                condition: { id: '3000', name: 'Used', description: 'Excellent', descriptors: [] },
                aspects: { Mount: ['Canon EF'], Brand: ['Canon'] },
                identifiers: { brand: 'Canon', mpn: null, upc: [], ean: [], isbn: [], epid: null },
                commerce: { price: { value: '39.95', currency: 'USD' }, totalQuantity: 1, soldQuantity: 0,
                    availableQuantity: 1, availableQuantityBasis: 'reported', bestOfferEnabled: false },
                policies: { fulfillmentPolicyId: '111', paymentPolicyId: '222', returnPolicyId: '333',
                    paymentMethods: [], shippingType: null, domesticServices: [], internationalServices: [],
                    returnsAccepted: true, returnPeriod: null, returnShippingCostPayer: null },
                location: { publicLocation: 'Utah', countryCode: 'US' },
            },
            management: { model: 'inventory_offer', controlApi: 'inventory', joinKey: 'exact_raw_sku',
                exactBindings: { seller: true, listing: true, sku: true, inventoryItem: true,
                    offer: true, offerToListing: true }, lifecycleAligned: true,
                inventoryItem: { sku, content: { title: options.ebayTitle ?? 'eBay Old',
                        descriptionHtml: null, imageUrls: [] }, condition: { id: '3000', name: 'Used',
                        description: null, descriptors: [] }, aspects: {}, identifiers: { brand: 'Canon',
                        mpn: null, upc: [], ean: [], isbn: [], epid: null }, shipToLocationQuantity: 1 },
                offer: { offerId, sku, marketplaceId: 'EBAY_US', status: 'PUBLISHED',
                    listingStatus: 'ACTIVE', listingOnHold: false, soldQuantity: 0, format: 'FIXED_PRICE',
                    duration: 'GTC', descriptionHtml: null, primaryCategoryId: '3323',
                    secondaryCategoryId: null, storeCategoryNames: [], price: null, availableQuantity: 1,
                    quantityLimitPerBuyer: null, bestOfferEnabled: false, autoAcceptPrice: null,
                    autoDeclinePrice: null, fulfillmentPolicyId: '111', paymentPolicyId: '222',
                    returnPolicyId: '333', merchantLocationKey: 'warehouse-1',
                    includeCatalogProductDetails: false },
            },
        },
    };
}
let currentWorkspace = workspace();
function mintSessionToken(input) {
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const encode = (value) => Buffer
        .from(JSON.stringify(value), 'utf8').toString('base64url');
    const header = encode({ alg: 'HS256', typ: 'JWT' });
    const destination = input.destination
        ?? `https://${PRODUCT_PIPELINE_SHOPIFY_IDENTITY.storeDomain}`;
    const payload = encode({
        iss: `${destination}/admin`,
        dest: destination,
        aud: input.audience ?? PRODUCT_PIPELINE_SHOPIFY_IDENTITY.clientId,
        sub: input.subject ?? EXERCISE_SUBJECT,
        exp: nowSeconds + 120, nbf: nowSeconds - 5, iat: nowSeconds,
        jti: 'g3-exercise-token', sid: 'g3-exercise-session',
    });
    const signature = crypto.createHmac('sha256', input.secret)
        .update(`${header}.${payload}`).digest('base64url');
    return `${header}.${payload}.${signature}`;
}
function saveBody(input) {
    return {
        schemaVersion: 1, action: 'save_local_draft', catalogId: CATALOG_ID,
        expectedRevisionDigest: input.expectedRevisionDigest, base: input.base,
        draft: { title: input.title, category: null, condition: null, conditionDescription: null,
            description: null, images: null, itemSpecifics: null,
            fulfillmentPolicyId: null, paymentPolicyId: null,
            returnPolicyId: null, merchantLocation: null },
    };
}
async function listen(app) {
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise((resolve) => server.once('listening', () => resolve()));
    return `http://127.0.0.1:${server.address().port}`;
}
function runAdmin(command) {
    const lines = [];
    buildListingControlAdminProgram({ output: (value) => lines.push(value) })
        .parse([command], { from: 'user' });
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0]);
}
beforeAll(() => {
    for (const key of ENVIRONMENT_KEYS)
        savedEnvironment.set(key, process.env[key]);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'g3-draft-exercise-'));
    fs.chmodSync(root, 0o700);
    databasePath = path.join(root, 'listing-control.sqlite');
    localSessionSecret = crypto.randomBytes(32).toString('hex');
    // Exercise the production authentication path: no test-mode bypass, no
    // operator API key, environment-only Shopify verification material with the
    // pinned client id and a random local signing secret.
    process.env.NODE_ENV = 'production';
    delete process.env.TEST_MODE;
    delete process.env.API_KEY;
    delete process.env.ALLOW_OPERATOR_API_KEY;
    process.env.SHOPIFY_CLIENT_ID = PRODUCT_PIPELINE_SHOPIFY_IDENTITY.clientId;
    process.env.SHOPIFY_CLIENT_SECRET = localSessionSecret;
    delete process.env.SHOPIFY_PREVIOUS_CLIENT_SECRET;
    delete process.env.SHOPIFY_PREVIOUS_CLIENT_SECRET_EXPIRES_AT_UTC;
    process.env.LISTING_CONTROL_DATABASE_PATH = databasePath;
    process.env.LISTING_CONTROL_SINGLE_WRITER_ACK = 'product-pipeline-local-draft-v1';
});
afterAll(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(() => resolve()))));
    LISTING_DRAFT_ROUTE_TESTING.resetWriteRates();
    for (const key of ENVIRONMENT_KEYS) {
        const value = savedEnvironment.get(key);
        if (value === undefined)
            delete process.env[key];
        else
            process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
});
describe('G3 exercise: authenticated bounded local draft append', () => {
    it('performs one bounded append with revision, stale-base, and admin verification proof', async () => {
        // 1. Initialize the store exactly as the operator runbook does.
        expect(runAdmin('init')).toEqual({
            status: 'initialized', schemaVersion: 2, mode: 'local_draft_only',
            externalWritesPerformed: 0,
        });
        // 2. Mount the exact production middleware order from src/server/index.ts.
        const app = express();
        app.use(rateLimit);
        app.use('/api', apiKeyAuth);
        app.use('/api', writerQuarantineMiddleware);
        app.post('/api/listing-draft', listingDraftJsonParser);
        app.use(listingDraftJsonErrorHandler);
        app.use(createListingDraftRouter(createListingDraftService({
            readWorkspace: async () => currentWorkspace,
        })));
        const base = await listen(app);
        const draftUrl = `${base}/api/listing-draft`;
        const token = mintSessionToken({ secret: localSessionSecret });
        // 3. Authentication is enforced by the real verifier: missing, forged, and
        //    wrong-audience tokens are all rejected before any service work.
        const unauthenticated = await fetch(`${draftUrl}?id=${encodeURIComponent(CATALOG_ID)}`);
        expect(unauthenticated.status).toBe(401);
        const forged = await fetch(`${draftUrl}?id=${encodeURIComponent(CATALOG_ID)}`, {
            headers: { authorization: `Bearer ${mintSessionToken({ secret: 'wrong-secret-material' })}` },
        });
        expect(forged.status).toBe(401);
        const wrongAudience = await fetch(`${draftUrl}?id=${encodeURIComponent(CATALOG_ID)}`, {
            headers: { authorization: `Bearer ${mintSessionToken({
                    secret: localSessionSecret, audience: 'not-the-product-pipeline-app'
                })}` },
        });
        expect(wrongAudience.status).toBe(401);
        // 4. Open the workspace with a genuine verified session principal.
        const opened = await fetch(`${draftUrl}?id=${encodeURIComponent(CATALOG_ID)}`, {
            headers: { authorization: `Bearer ${token}` },
        });
        expect(opened.status).toBe(200);
        const openedDto = await opened.json();
        expect(openedDto.capabilities).toEqual({
            saveDraft: true, previewChanges: true, apply: false, publish: false,
        });
        expect(openedDto.revision).toBeNull();
        expect(openedDto.externalWritesPerformed).toBe(0);
        // 5. One bounded authenticated append. The browser save contract carries
        //    only the two semantic base digests, never the observation timestamps.
        const semanticBase = {
            sourceDigest: openedDto.base.sourceDigest, ebayDigest: openedDto.base.ebayDigest,
        };
        const saved = await fetch(draftUrl, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(saveBody({
                base: semanticBase, expectedRevisionDigest: null, title: 'G3 Exercise Title',
            })),
        });
        expect(saved.status).toBe(201);
        const savedDto = await saved.json();
        expect(savedDto.revision.revisionNumber).toBe(1);
        expect(savedDto.sections.listing.title.draft).toBe('G3 Exercise Title');
        // 6. The stored revision is durable, actor-attributed, and audit-chained.
        const persisted = openListingControlStoreReadOnly({
            databasePath, expectedScope: LISTING_DRAFT_SCOPE,
        });
        const storedRevision = persisted.getLatestRevision(VARIANT_GID);
        expect(storedRevision).not.toBeNull();
        expect(storedRevision).toMatchObject({
            revisionNumber: 1,
            revisionDigest: savedDto.revision.revisionDigest,
            actor: `shopify-user:${EXERCISE_SUBJECT}`,
            state: 'draft',
        });
        expect(storedRevision.fields.find((field) => field.field === 'title')).toMatchObject({
            overrideValue: 'G3 Exercise Title', proposedSource: 'override',
        });
        expect(persisted.verifyAudit()).toMatchObject({ valid: true, recordCount: 2 });
        persisted.verifyIntegrity();
        persisted.close();
        // 7. Replaying the same request is a stale append and changes nothing.
        const replay = await fetch(draftUrl, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(saveBody({
                base: semanticBase, expectedRevisionDigest: null, title: 'G3 Exercise Title',
            })),
        });
        expect(replay.status).toBe(409);
        expect(await replay.json()).toMatchObject({ code: 'LISTING_DRAFT_STALE' });
        // 8. A remote eBay change invalidates the previously observed base even
        //    when the caller supplies the correct latest revision digest.
        currentWorkspace = workspace({ ebayTitle: 'eBay Changed Remotely' });
        const staleBase = await fetch(draftUrl, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(saveBody({
                base: semanticBase,
                expectedRevisionDigest: savedDto.revision.revisionDigest,
                title: 'Should Not Persist',
            })),
        });
        expect(staleBase.status).toBe(409);
        expect(await staleBase.json()).toMatchObject({ code: 'LISTING_DRAFT_STALE' });
        // 9. Reopening against current facts restores the append path with CAS.
        const reopened = await fetch(`${draftUrl}?id=${encodeURIComponent(CATALOG_ID)}`, {
            headers: { authorization: `Bearer ${token}` },
        });
        expect(reopened.status).toBe(200);
        const reopenedDto = await reopened.json();
        expect(reopenedDto.revision.revisionDigest).toBe(savedDto.revision.revisionDigest);
        const second = await fetch(draftUrl, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(saveBody({
                base: {
                    sourceDigest: reopenedDto.base.sourceDigest,
                    ebayDigest: reopenedDto.base.ebayDigest,
                },
                expectedRevisionDigest: reopenedDto.revision.revisionDigest,
                title: 'G3 Exercise Title Two',
            })),
        });
        expect(second.status).toBe(201);
        const secondDto = await second.json();
        expect(secondDto.revision.revisionNumber).toBe(2);
        // 10. Noncanonical siblings stay quarantined even for the verified session.
        const quarantined = await fetch(`${base}/api/listing-drafts`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: '{}',
        });
        expect(quarantined.status).toBe(423);
        // 11. The real admin verify accepts the exercised store unchanged.
        expect(runAdmin('verify')).toEqual({
            status: 'verified', schemaVersion: 2, mode: 'local_draft_only',
            externalWritesPerformed: 0,
        });
        const transcriptTarget = process.env.LISTING_DRAFT_EXERCISE_TRANSCRIPT_TARGET;
        if (typeof transcriptTarget === 'string' && transcriptTarget.length > 0) {
            fs.writeFileSync(transcriptTarget, `${JSON.stringify({
                exercise: 'g3-local-draft-append',
                performedAtUtc: new Date().toISOString(),
                catalogId: CATALOG_ID,
                actor: `shopify-user:${EXERCISE_SUBJECT}`,
                base: semanticBase,
                firstRevision: savedDto.revision,
                staleReplayStatus: replay.status,
                staleBaseStatus: staleBase.status,
                secondRevisionNumber: secondDto.revision.revisionNumber,
                adminVerify: runAdmin('verify'),
                externalWritesPerformed: 0,
            }, null, 2)}\n`, { mode: 0o600 });
        }
    });
});
