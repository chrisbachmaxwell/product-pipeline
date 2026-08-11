import { createHash } from "node:crypto";
const IDENTITY_SCOPE = "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly";
const INVENTORY_SCOPE = "https://api.ebay.com/oauth/api_scope/sell.inventory.readonly";
const FULFILLMENT_SCOPE = "https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly";
export const EBAY_READ_SCOPES = Object.freeze({
    identity: IDENTITY_SCOPE,
    inventory: INVENTORY_SCOPE,
    fulfillment: FULFILLMENT_SCOPE,
});
const ALLOWED_SCOPES = new Set(Object.values(EBAY_READ_SCOPES));
const MAX_USER_TOKEN_LIFETIME_MS = 2 * 60 * 60 * 1_000;
const MIN_TOKEN_REMAINING_MS = 5 * 60 * 1_000;
const MAX_ORDER_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_ORDER_WINDOW_LAG_MS = 15 * 60 * 1_000;
const MAX_SAFE_TEXT_LENGTH = 512;
const HOSTS = Object.freeze({
    production: Object.freeze({
        identity: "apiz.ebay.com",
        sell: "api.ebay.com",
    }),
    sandbox: Object.freeze({
        identity: "apiz.sandbox.ebay.com",
        sell: "api.sandbox.ebay.com",
    }),
});
const ORDER_WINDOW_BRAND = Symbol("verified-ebay-order-window");
const verifiedOrderWindows = new WeakSet();
export class EbayEvidenceError extends Error {
    code;
    constructor(code) {
        super(`eBay evidence capture denied (${code}).`);
        this.name = "EbayEvidenceError";
        this.code = code;
    }
    toJSON() {
        return Object.freeze({ name: this.name, code: this.code, message: this.message });
    }
}
function fail(code) {
    throw new EbayEvidenceError(code);
}
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireObject(value, code) {
    if (!isObject(value))
        fail(code);
    return value;
}
function requireExactKeys(value, keys, code) {
    const expected = new Set(keys);
    const actual = Object.keys(value);
    if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
        fail(code);
    }
}
function canonicalUtc(value, code) {
    if (typeof value !== "string")
        fail(code);
    const ms = Date.parse(value);
    if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value)
        fail(code);
    return { text: value, ms };
}
function safeText(value, code, max = MAX_SAFE_TEXT_LENGTH) {
    if (typeof value !== "string" ||
        value.length < 1 ||
        value.length > max ||
        value.trim() !== value ||
        /[\u0000-\u001f\u007f]/u.test(value)) {
        fail(code);
    }
    return value;
}
function optionalSafeText(value, code) {
    if (value === undefined || value === null)
        return null;
    return safeText(value, code);
}
function nonNegativeInteger(value, code) {
    if (!Number.isSafeInteger(value) || value < 0)
        fail(code);
    return value;
}
function positiveIntegerInRange(value, minimum, maximum, code) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        fail(code);
    }
    return value;
}
function optionalNonNegativeInteger(value, code) {
    if (value === undefined || value === null)
        return null;
    return nonNegativeInteger(value, code);
}
function optionalBoolean(value, code) {
    if (value === undefined || value === null)
        return null;
    if (typeof value !== "boolean")
        fail(code);
    return value;
}
function strictSafeIdentifier(value, code) {
    const text = safeText(value, code, 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(text))
        fail(code);
    if (/(?:access.?token|authorization|bearer|client.?secret|refresh.?token)/iu.test(text)) {
        fail(code);
    }
    return text;
}
function validateConfig(input) {
    const config = requireObject(input, "invalid-config");
    requireExactKeys(config, ["environment", "capturedAtUtc", "expectedIdentity", "authorization", "limits"], "invalid-config");
    if (config.environment !== "production" && config.environment !== "sandbox") {
        fail("invalid-config");
    }
    const capturedAt = canonicalUtc(config.capturedAtUtc, "invalid-config");
    const identityInput = requireObject(config.expectedIdentity, "invalid-config");
    requireExactKeys(identityInput, ["userId", "registrationMarketplaceId"], "invalid-config");
    const userId = safeText(identityInput.userId, "invalid-config", 128);
    const registrationMarketplaceId = safeText(identityInput.registrationMarketplaceId, "invalid-config", 64);
    if (!/^EBAY_[A-Z0-9_]+$/u.test(registrationMarketplaceId))
        fail("invalid-config");
    const authorization = requireObject(config.authorization, "invalid-authorization");
    requireExactKeys(authorization, [
        "kind",
        "scopes",
        "issuedAtUtc",
        "expiresAtUtc",
        "refreshSupported",
        "credentialProvidedToCollector",
    ], "invalid-authorization");
    if (authorization.kind !== "ephemeral-user-access-attestation" ||
        authorization.refreshSupported !== false ||
        authorization.credentialProvidedToCollector !== false ||
        !Array.isArray(authorization.scopes) ||
        authorization.scopes.length < 1 ||
        authorization.scopes.length > ALLOWED_SCOPES.size) {
        fail("invalid-authorization");
    }
    const scopes = new Set();
    for (const scope of authorization.scopes) {
        if (typeof scope !== "string" || !ALLOWED_SCOPES.has(scope) || scopes.has(scope)) {
            fail("authorization-scope-denied");
        }
        scopes.add(scope);
    }
    if (!scopes.has(IDENTITY_SCOPE))
        fail("authorization-scope-denied");
    const issuedAt = canonicalUtc(authorization.issuedAtUtc, "invalid-authorization");
    const expiresAt = canonicalUtc(authorization.expiresAtUtc, "invalid-authorization");
    if (issuedAt.ms > capturedAt.ms || expiresAt.ms <= issuedAt.ms) {
        fail("invalid-authorization");
    }
    if (expiresAt.ms - issuedAt.ms > MAX_USER_TOKEN_LIFETIME_MS) {
        fail("invalid-authorization");
    }
    if (expiresAt.ms <= capturedAt.ms)
        fail("authorization-expired");
    if (expiresAt.ms - capturedAt.ms < MIN_TOKEN_REMAINING_MS) {
        fail("authorization-near-expiry");
    }
    const limitsInput = requireObject(config.limits, "invalid-config");
    requireExactKeys(limitsInput, [
        "timeoutMs",
        "maxResponseBytes",
        "maxTotalResponseBytes",
        "maxInventoryPages",
        "maxInventoryItems",
        "maxOfferPages",
        "maxOffers",
        "maxOrderPages",
        "maxOrders",
    ], "invalid-config");
    const limits = Object.freeze({
        timeoutMs: positiveIntegerInRange(limitsInput.timeoutMs, 100, 30_000, "invalid-config"),
        maxResponseBytes: positiveIntegerInRange(limitsInput.maxResponseBytes, 256, 16 * 1024 * 1024, "invalid-config"),
        maxTotalResponseBytes: positiveIntegerInRange(limitsInput.maxTotalResponseBytes, 256, 64 * 1024 * 1024, "invalid-config"),
        maxInventoryPages: positiveIntegerInRange(limitsInput.maxInventoryPages, 1, 10_000, "invalid-config"),
        maxInventoryItems: positiveIntegerInRange(limitsInput.maxInventoryItems, 1, 1_000_000, "invalid-config"),
        maxOfferPages: positiveIntegerInRange(limitsInput.maxOfferPages, 1, 100_000, "invalid-config"),
        maxOffers: positiveIntegerInRange(limitsInput.maxOffers, 1, 1_000_000, "invalid-config"),
        maxOrderPages: positiveIntegerInRange(limitsInput.maxOrderPages, 1, 10_000, "invalid-config"),
        maxOrders: positiveIntegerInRange(limitsInput.maxOrders, 1, 1_000_000, "invalid-config"),
    });
    if (limits.maxTotalResponseBytes < limits.maxResponseBytes)
        fail("invalid-config");
    return Object.freeze({
        environment: config.environment,
        capturedAtUtc: capturedAt.text,
        capturedAtMs: capturedAt.ms,
        expectedIdentity: Object.freeze({ userId, registrationMarketplaceId }),
        scopes,
        limits,
    });
}
function validateTransport(input) {
    if (input === undefined)
        return undefined;
    const transport = requireObject(input, "invalid-config");
    requireExactKeys(transport, ["provenance", "get"], "invalid-config");
    if (typeof transport.get !== "function")
        fail("invalid-config");
    const provenance = requireObject(transport.provenance, "invalid-config");
    if (provenance.kind === "fixture") {
        requireExactKeys(provenance, ["kind", "fixtureId"], "invalid-config");
        strictSafeIdentifier(provenance.fixtureId, "invalid-config");
    }
    else if (provenance.kind === "direct-ebay-api") {
        requireExactKeys(provenance, ["kind", "captureSessionId"], "invalid-config");
        strictSafeIdentifier(provenance.captureSessionId, "invalid-config");
    }
    else {
        fail("invalid-config");
    }
    return input;
}
export function createEbayOrderWindow(input) {
    const raw = requireObject(input, "invalid-order-window");
    requireExactKeys(raw, ["startUtc", "endUtc", "asOfUtc"], "invalid-order-window");
    const start = canonicalUtc(raw.startUtc, "invalid-order-window");
    const end = canonicalUtc(raw.endUtc, "invalid-order-window");
    const asOf = canonicalUtc(raw.asOfUtc, "invalid-order-window");
    if (start.ms >= end.ms ||
        end.ms > asOf.ms ||
        asOf.ms - end.ms > MAX_ORDER_WINDOW_LAG_MS ||
        end.ms - start.ms > MAX_ORDER_WINDOW_MS ||
        start.ms < asOf.ms - MAX_ORDER_WINDOW_MS) {
        fail("invalid-order-window");
    }
    const window = Object.freeze({
        startUtc: start.text,
        endUtc: end.text,
        asOfUtc: asOf.text,
        historicalBackfill: false,
        lowerBoundInclusive: true,
        upperBoundExclusive: true,
        [ORDER_WINDOW_BRAND]: true,
    });
    verifiedOrderWindows.add(window);
    return window;
}
function assertVerifiedOrderWindow(value, capturedAtUtc) {
    if (!isObject(value) || !verifiedOrderWindows.has(value) || value.asOfUtc !== capturedAtUtc) {
        fail("invalid-order-window");
    }
}
function exactUrl(host, path, query) {
    const url = new URL(`https://${host}${path}`);
    if (query) {
        for (const [key, value] of Object.entries(query))
            url.searchParams.set(key, value);
    }
    return url.toString();
}
function endpointEvidence(urlText, scope) {
    const url = new URL(urlText);
    return Object.freeze({ method: "GET", host: url.host, path: url.pathname, requiredScope: scope });
}
function measureBody(body) {
    try {
        const json = JSON.stringify(body);
        if (json === undefined)
            fail("response-invalid");
        return new TextEncoder().encode(json).byteLength;
    }
    catch (error) {
        if (error instanceof EbayEvidenceError)
            throw error;
        fail("response-invalid");
    }
}
function cloneProvenance(provenance) {
    return provenance.kind === "fixture"
        ? Object.freeze({ kind: "fixture", fixtureId: provenance.fixtureId })
        : Object.freeze({ kind: "direct-ebay-api", captureSessionId: provenance.captureSessionId });
}
function assertNoPartialDiagnostics(body) {
    for (const key of ["errors", "warnings"]) {
        if (body[key] === undefined)
            continue;
        if (!Array.isArray(body[key]) || body[key].length > 0)
            fail("incomplete-capture");
    }
}
async function requestJson(transport, config, context, url, scope) {
    if (!transport)
        fail("transport-unavailable");
    if (!config.scopes.has(scope))
        fail("authorization-scope-denied");
    const controller = new AbortController();
    const boundedRequest = Object.freeze({
        method: "GET",
        url,
        headers: Object.freeze({ Accept: "application/json" }),
        redirect: "error",
        requiredScope: scope,
        signal: controller.signal,
        credentialProvidedToCollector: false,
    });
    let timer;
    try {
        const timeout = new Promise((_resolve, reject) => {
            timer = setTimeout(() => {
                controller.abort();
                reject(new EbayEvidenceError("transport-timeout"));
            }, config.limits.timeoutMs);
        });
        const response = await Promise.race([transport.get(boundedRequest), timeout]);
        const responseObject = requireObject(response, "response-invalid");
        requireExactKeys(responseObject, ["status", "body"], "response-invalid");
        if (responseObject.status !== 200)
            fail("transport-failure");
        const bytes = measureBody(responseObject.body);
        if (bytes > config.limits.maxResponseBytes)
            fail("response-too-large");
        context.responseBytes += bytes;
        if (context.responseBytes > config.limits.maxTotalResponseBytes) {
            fail("response-too-large");
        }
        context.requests.push(endpointEvidence(url, scope));
        const body = requireObject(responseObject.body, "response-invalid");
        assertNoPartialDiagnostics(body);
        return body;
    }
    catch (error) {
        if (error instanceof EbayEvidenceError)
            throw error;
        return fail("transport-failure");
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
function validatePageLink(value, expectedHost, expectedPath, expectedParams) {
    if (typeof value !== "string")
        fail("pagination-invalid");
    let url;
    try {
        url = new URL(value);
    }
    catch {
        fail("pagination-invalid");
    }
    if (url.protocol !== "https:" ||
        url.host !== expectedHost ||
        url.pathname !== expectedPath ||
        url.username !== "" ||
        url.password !== "" ||
        url.hash !== "") {
        fail("pagination-invalid");
    }
    const entries = [...url.searchParams.entries()];
    const keys = Object.keys(expectedParams);
    if (entries.length !== keys.length)
        fail("pagination-invalid");
    for (const [key, expected] of Object.entries(expectedParams)) {
        const values = url.searchParams.getAll(key);
        if (values.length !== 1 || values[0] !== expected)
            fail("pagination-invalid");
    }
}
async function verifyIdentity(transport, config, context) {
    const host = HOSTS[config.environment].identity;
    const body = await requestJson(transport, config, context, exactUrl(host, "/commerce/identity/v1/user/"), IDENTITY_SCOPE);
    const userId = safeText(body.userId, "response-invalid", 128);
    const registrationMarketplaceId = safeText(body.registrationMarketplaceId, "response-invalid", 64);
    if (userId !== config.expectedIdentity.userId ||
        registrationMarketplaceId !== config.expectedIdentity.registrationMarketplaceId) {
        fail("identity-mismatch");
    }
    return Object.freeze({ userId, registrationMarketplaceId });
}
function arrayOrEmptyForZeroTotal(value, total, code) {
    if (value === undefined && total === 0)
        return [];
    if (!Array.isArray(value))
        fail(code);
    return value;
}
function inventoryItemFromRaw(value) {
    const item = requireObject(value, "response-invalid");
    const sku = safeText(item.sku, "response-invalid", 50);
    let inventoryItemGroupKeys = Object.freeze([]);
    if (item.inventoryItemGroupKeys !== undefined) {
        if (!Array.isArray(item.inventoryItemGroupKeys))
            fail("response-invalid");
        const keys = item.inventoryItemGroupKeys.map((entry) => safeText(entry, "response-invalid", 128));
        if (new Set(keys).size !== keys.length)
            fail("duplicate-stable-id");
        inventoryItemGroupKeys = Object.freeze([...keys].sort());
    }
    let quantity = null;
    if (item.availability !== undefined) {
        const availability = requireObject(item.availability, "response-invalid");
        if (availability.shipToLocationAvailability !== undefined) {
            const shipTo = requireObject(availability.shipToLocationAvailability, "response-invalid");
            quantity = optionalNonNegativeInteger(shipTo.quantity, "response-invalid");
        }
    }
    return Object.freeze({
        sku,
        locale: optionalSafeText(item.locale, "response-invalid"),
        condition: optionalSafeText(item.condition, "response-invalid"),
        inventoryItemGroupKeys,
        shipToLocationQuantity: quantity,
    });
}
function offerFromRaw(value, expectedSku, expectedMarketplaceId) {
    const offer = requireObject(value, "response-invalid");
    const offerId = safeText(offer.offerId, "response-invalid", 128);
    const sku = safeText(offer.sku, "response-invalid", 50);
    const marketplaceId = safeText(offer.marketplaceId, "response-invalid", 64);
    if (sku !== expectedSku || marketplaceId !== expectedMarketplaceId) {
        fail("incomplete-capture");
    }
    let price = null;
    if (offer.pricingSummary !== undefined) {
        const pricingSummary = requireObject(offer.pricingSummary, "response-invalid");
        if (pricingSummary.price !== undefined) {
            const rawPrice = requireObject(pricingSummary.price, "response-invalid");
            price = Object.freeze({
                currency: safeText(rawPrice.currency, "response-invalid", 16),
                value: safeText(rawPrice.value, "response-invalid", 64),
            });
        }
    }
    let listing = null;
    if (offer.listing !== undefined) {
        const rawListing = requireObject(offer.listing, "response-invalid");
        listing = Object.freeze({
            listingId: optionalSafeText(rawListing.listingId, "response-invalid"),
            listingStatus: optionalSafeText(rawListing.listingStatus, "response-invalid"),
            soldQuantity: optionalNonNegativeInteger(rawListing.soldQuantity, "response-invalid"),
            listingOnHold: optionalBoolean(rawListing.listingOnHold, "response-invalid"),
        });
    }
    return Object.freeze({
        offerId,
        sku,
        marketplaceId,
        format: optionalSafeText(offer.format, "response-invalid"),
        status: optionalSafeText(offer.status, "response-invalid"),
        availableQuantity: optionalNonNegativeInteger(offer.availableQuantity, "response-invalid"),
        categoryId: optionalSafeText(offer.categoryId, "response-invalid"),
        price,
        listing,
    });
}
function orderFromRaw(value) {
    const order = requireObject(value, "response-invalid");
    return Object.freeze({
        orderId: safeText(order.orderId, "response-invalid", 128),
        creationDate: canonicalUtc(order.creationDate, "response-invalid").text,
        lastModifiedDate: canonicalUtc(order.lastModifiedDate, "response-invalid").text,
        orderFulfillmentStatus: safeText(order.orderFulfillmentStatus, "response-invalid", 64),
    });
}
function readInventoryPageEnvelope(body, expectedLimit) {
    const limit = nonNegativeInteger(body.limit, "response-invalid");
    const total = nonNegativeInteger(body.total, "response-invalid");
    if (limit !== expectedLimit)
        fail("pagination-invalid");
    return { total, next: body.next };
}
function readOrderPageEnvelope(body, expectedLimit, expectedOffset) {
    const limit = nonNegativeInteger(body.limit, "response-invalid");
    const offset = nonNegativeInteger(body.offset, "response-invalid");
    const total = nonNegativeInteger(body.total, "response-invalid");
    if (limit !== expectedLimit || offset !== expectedOffset)
        fail("pagination-invalid");
    return { total, next: body.next };
}
function assertTerminalState(next, collected, total) {
    if (collected > total)
        fail("incomplete-capture");
    if (collected === total) {
        if (next !== undefined && next !== null && next !== "")
            fail("pagination-invalid");
        return "terminal";
    }
    if (typeof next !== "string" || next.length === 0)
        fail("incomplete-capture");
    return "continue";
}
function canonicalJson(value) {
    if (value === null || typeof value === "boolean" || typeof value === "string") {
        return JSON.stringify(value);
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value))
            fail("response-invalid");
        return JSON.stringify(value);
    }
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    if (isObject(value)) {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
    }
    return fail("response-invalid");
}
function digest(value) {
    return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
async function collectInventoryItems(transport, config, context) {
    const host = HOSTS[config.environment].sell;
    const path = "/sell/inventory/v1/inventory_item";
    const pageSize = 200;
    const items = [];
    const seenSkus = new Set();
    const seenNext = new Set();
    let expectedTotal;
    for (let page = 0; page < config.limits.maxInventoryPages; page += 1) {
        const params = { limit: String(pageSize), offset: String(page) };
        const body = await requestJson(transport, config, context, exactUrl(host, path, params), INVENTORY_SCOPE);
        const envelope = readInventoryPageEnvelope(body, pageSize);
        if (expectedTotal === undefined)
            expectedTotal = envelope.total;
        if (envelope.total !== expectedTotal)
            fail("incomplete-capture");
        if (envelope.total > config.limits.maxInventoryItems)
            fail("response-limit-exceeded");
        const rawItems = arrayOrEmptyForZeroTotal(body.inventoryItems, envelope.total, "response-invalid");
        if (rawItems.length > pageSize || (rawItems.length === 0 && items.length < envelope.total)) {
            fail("incomplete-capture");
        }
        for (const raw of rawItems) {
            const item = inventoryItemFromRaw(raw);
            if (seenSkus.has(item.sku))
                fail("duplicate-stable-id");
            seenSkus.add(item.sku);
            items.push(item);
        }
        if (items.length > config.limits.maxInventoryItems)
            fail("response-limit-exceeded");
        if (assertTerminalState(envelope.next, items.length, envelope.total) === "terminal") {
            return items.sort((left, right) => left.sku.localeCompare(right.sku));
        }
        if (rawItems.length !== pageSize)
            fail("incomplete-capture");
        if (seenNext.has(envelope.next))
            fail("pagination-loop");
        seenNext.add(envelope.next);
        validatePageLink(envelope.next, host, path, {
            limit: String(pageSize),
            offset: String(page + 1),
        });
    }
    fail("response-limit-exceeded");
}
async function collectOffersForInventory(transport, config, context, inventoryItems) {
    const host = HOSTS[config.environment].sell;
    const path = "/sell/inventory/v1/offer";
    const pageSize = 25;
    const offers = [];
    const seenOfferIds = new Set();
    let pagesUsed = 0;
    for (const item of inventoryItems) {
        const offersBeforeSku = offers.length;
        let page = 0;
        let collectedForSku = 0;
        let expectedTotal;
        const seenNext = new Set();
        while (true) {
            pagesUsed += 1;
            if (pagesUsed > config.limits.maxOfferPages)
                fail("response-limit-exceeded");
            const params = {
                sku: item.sku,
                marketplace_id: config.expectedIdentity.registrationMarketplaceId,
                limit: String(pageSize),
                offset: String(page),
            };
            const body = await requestJson(transport, config, context, exactUrl(host, path, params), INVENTORY_SCOPE);
            const envelope = readInventoryPageEnvelope(body, pageSize);
            if (expectedTotal === undefined)
                expectedTotal = envelope.total;
            if (envelope.total !== expectedTotal)
                fail("incomplete-capture");
            if (offersBeforeSku + envelope.total > config.limits.maxOffers) {
                fail("response-limit-exceeded");
            }
            const rawOffers = arrayOrEmptyForZeroTotal(body.offers, envelope.total, "response-invalid");
            if (rawOffers.length > pageSize ||
                (rawOffers.length === 0 && collectedForSku < envelope.total)) {
                fail("incomplete-capture");
            }
            for (const raw of rawOffers) {
                const offer = offerFromRaw(raw, item.sku, config.expectedIdentity.registrationMarketplaceId);
                if (seenOfferIds.has(offer.offerId))
                    fail("duplicate-stable-id");
                seenOfferIds.add(offer.offerId);
                offers.push(offer);
                collectedForSku += 1;
            }
            if (assertTerminalState(envelope.next, collectedForSku, envelope.total) === "terminal") {
                break;
            }
            if (rawOffers.length !== pageSize)
                fail("incomplete-capture");
            if (seenNext.has(envelope.next))
                fail("pagination-loop");
            seenNext.add(envelope.next);
            page += 1;
            validatePageLink(envelope.next, host, path, {
                sku: item.sku,
                marketplace_id: config.expectedIdentity.registrationMarketplaceId,
                limit: String(pageSize),
                offset: String(page),
            });
        }
    }
    return offers.sort((left, right) => left.offerId.localeCompare(right.offerId));
}
async function collectOrders(transport, config, context, window) {
    const host = HOSTS[config.environment].sell;
    const path = "/sell/fulfillment/v1/order";
    const pageSize = 200;
    const inclusiveFilter = `creationdate:[${window.startUtc}..${window.endUtc}]`;
    const rawOrders = [];
    const seenOrderIds = new Set();
    const seenNext = new Set();
    let expectedTotal;
    let offset = 0;
    for (let page = 0; page < config.limits.maxOrderPages; page += 1) {
        const params = {
            filter: inclusiveFilter,
            limit: String(pageSize),
            offset: String(offset),
        };
        const body = await requestJson(transport, config, context, exactUrl(host, path, params), FULFILLMENT_SCOPE);
        const envelope = readOrderPageEnvelope(body, pageSize, offset);
        if (expectedTotal === undefined)
            expectedTotal = envelope.total;
        if (envelope.total !== expectedTotal)
            fail("incomplete-capture");
        if (envelope.total > config.limits.maxOrders)
            fail("response-limit-exceeded");
        const pageOrders = arrayOrEmptyForZeroTotal(body.orders, envelope.total, "response-invalid");
        if (pageOrders.length > pageSize || (pageOrders.length === 0 && rawOrders.length < envelope.total)) {
            fail("incomplete-capture");
        }
        for (const raw of pageOrders) {
            const order = orderFromRaw(raw);
            if (seenOrderIds.has(order.orderId))
                fail("duplicate-stable-id");
            seenOrderIds.add(order.orderId);
            const creationMs = Date.parse(order.creationDate);
            if (creationMs < Date.parse(window.startUtc) || creationMs > Date.parse(window.endUtc)) {
                fail("incomplete-capture");
            }
            rawOrders.push(order);
        }
        if (assertTerminalState(envelope.next, rawOrders.length, envelope.total) === "terminal")
            break;
        if (pageOrders.length !== pageSize)
            fail("incomplete-capture");
        if (seenNext.has(envelope.next))
            fail("pagination-loop");
        seenNext.add(envelope.next);
        offset += pageOrders.length;
        validatePageLink(envelope.next, host, path, {
            filter: inclusiveFilter,
            limit: String(pageSize),
            offset: String(offset),
        });
        if (page + 1 >= config.limits.maxOrderPages)
            fail("response-limit-exceeded");
    }
    if (expectedTotal === undefined || rawOrders.length !== expectedTotal)
        fail("incomplete-capture");
    const endMs = Date.parse(window.endUtc);
    const records = rawOrders
        .filter((order) => Date.parse(order.creationDate) < endMs)
        .sort((left, right) => left.orderId.localeCompare(right.orderId));
    return { records, rawCount: rawOrders.length };
}
export function createEbayEvidenceCollector(configInput, transportInput) {
    const config = validateConfig(configInput);
    const transport = validateTransport(transportInput);
    return Object.freeze({
        collectInventoryAndOffers: async () => {
            if (!config.scopes.has(INVENTORY_SCOPE))
                fail("authorization-scope-denied");
            const context = { requests: [], responseBytes: 0 };
            const identity = await verifyIdentity(transport, config, context);
            const inventoryItems = await collectInventoryItems(transport, config, context);
            const offers = await collectOffersForInventory(transport, config, context, inventoryItems);
            const records = Object.freeze({
                inventoryItems: Object.freeze(inventoryItems),
                offers: Object.freeze(offers),
            });
            const result = {
                complete: true,
                evidenceMode: transport.provenance.kind,
                transportProvenance: cloneProvenance(transport.provenance),
                environment: config.environment,
                capturedAtUtc: config.capturedAtUtc,
                identity,
                coverage: Object.freeze({
                    model: "ebay-inventory-api-records-and-associated-offers-only",
                    allSellerListingsClaimed: false,
                    tradingApiListingsIncluded: false,
                    activeInventoryReportUsed: false,
                }),
                safeguards: Object.freeze({
                    getOnly: true,
                    oauthRefreshAbsent: true,
                    credentialsAbsentFromCollector: true,
                    externalWritesSupported: false,
                }),
                records,
                requests: Object.freeze([...context.requests]),
                responseBytes: context.responseBytes,
                recordDigest: digest(records),
            };
            return Object.freeze(result);
        },
        collectRecentOrders: async (window) => {
            assertVerifiedOrderWindow(window, config.capturedAtUtc);
            if (!config.scopes.has(FULFILLMENT_SCOPE))
                fail("authorization-scope-denied");
            const context = { requests: [], responseBytes: 0 };
            const identity = await verifyIdentity(transport, config, context);
            const collected = await collectOrders(transport, config, context, window);
            const records = Object.freeze(collected.records);
            const result = {
                complete: true,
                evidenceMode: transport.provenance.kind,
                transportProvenance: cloneProvenance(transport.provenance),
                environment: config.environment,
                capturedAtUtc: config.capturedAtUtc,
                identity,
                coverage: Object.freeze({
                    model: "ebay-fulfillment-completed-checkout-orders",
                    window: Object.freeze({
                        startUtc: window.startUtc,
                        endUtc: window.endUtc,
                        lowerBoundInclusive: true,
                        upperBoundExclusive: true,
                        ebayQueryUpperBoundIsInclusive: true,
                        upperBoundaryPostFiltered: true,
                    }),
                    historicalBackfill: false,
                    cutoverWatermark: false,
                }),
                safeguards: Object.freeze({
                    getOnly: true,
                    oauthRefreshAbsent: true,
                    credentialsAbsentFromCollector: true,
                    externalWritesSupported: false,
                    orderFieldsMinimized: true,
                }),
                records,
                rawInclusiveRecordCount: collected.rawCount,
                requests: Object.freeze([...context.requests]),
                responseBytes: context.responseBytes,
                recordDigest: digest(records),
            };
            return Object.freeze(result);
        },
    });
}
