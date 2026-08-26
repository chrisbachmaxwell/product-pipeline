import { createHash } from 'node:crypto';
import { SANDBOX_API_ORIGIN, SANDBOX_IDENTITY_ORIGIN, SANDBOX_MARKETPLACE, } from './manifest.js';
const MAX = 2 * 1024 * 1024;
const TIMEOUT = 20_000;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NUMERIC = /^[0-9]{1,20}$/;
const ALIGNMENT_SKU = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MONEY = /^[1-9][0-9]{0,9}\.[0-9]{2}$/;
export class SandboxAdapterError extends Error {
    code;
    constructor(code) {
        super('Sandbox provider operation denied');
        this.code = code;
        this.name = 'SandboxAdapterError';
    }
}
const deny = (code) => {
    throw new SandboxAdapterError(code);
};
/** Shared exact-one-entry serializer for Sandbox Inventory/Offer alignment. */
export function buildSandboxBulkUpdateBody(input) {
    if (!ALIGNMENT_SKU.test(input.sku) || !NUMERIC.test(input.offerId))
        deny('TARGET_INVALID');
    const request = input.field === 'price'
        ? { sku: input.sku, offers: [{ offerId: input.offerId, price: input.price }] }
        : {
            sku: input.sku,
            shipToLocationAvailability: { quantity: input.quantity },
            offers: [{ offerId: input.offerId, availableQuantity: input.quantity }],
        };
    const body = JSON.stringify({ requests: [request] });
    if (Buffer.byteLength(body, 'utf8') > MAX)
        deny('WRITE_FAILED');
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed.requests) || parsed.requests.length !== 1)
        deny('WRITE_FAILED');
    const keys = [];
    const collect = (value) => {
        if (Array.isArray(value))
            value.forEach(collect);
        else if (value !== null && typeof value === 'object') {
            for (const [key, entry] of Object.entries(value)) {
                keys.push(key);
                collect(entry);
            }
        }
    };
    collect(parsed);
    if (input.field === 'price') {
        if (input.price.currency !== 'USD' || !MONEY.test(input.price.value)
            || keys.some((key) => /quantity|availab/i.test(key)))
            deny('WRITE_FAILED');
    }
    else if (!Number.isSafeInteger(input.quantity) || input.quantity < 0
        || keys.some((key) => /price/i.test(key)))
        deny('WRITE_FAILED');
    return body;
}
function object(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        deny('RESPONSE_INVALID');
    return value;
}
function exactText(value, maximum = 50_000) {
    if (typeof value !== 'string' || value.length < 1 || value.length > maximum)
        deny('RESPONSE_INVALID');
    return value;
}
function exactInteger(value) {
    if (!Number.isSafeInteger(value) || Number(value) < 0)
        deny('RESPONSE_INVALID');
    return Number(value);
}
function xmlDecode(value) {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}
function xmlText(block, name) {
    const matches = [
        ...block.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'gi')),
    ];
    if (matches.length !== 1)
        deny('AMBIGUOUS_REMOTE_STATE');
    return xmlDecode(matches[0]?.[1] ?? '');
}
export async function readCredentialPacket(stream = process.stdin, now = new Date()) {
    const chunks = [];
    let size = 0;
    for await (const chunk of stream) {
        const b = Buffer.from(chunk);
        size += b.length;
        if (size > 12 * 1024)
            deny('CREDENTIAL_PACKET_TOO_LARGE');
        chunks.push(b);
    }
    let raw;
    try {
        raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    }
    finally {
        for (const b of chunks)
            b.fill(0);
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        deny('CREDENTIAL_PACKET_INVALID');
    const r = raw;
    if (Object.keys(r).sort().join('|') !==
        ['accessToken', 'expiresAtUtc', 'issuedAtUtc', 'scopes', 'sellerId'].sort().join('|') ||
        typeof r.accessToken !== 'string' ||
        r.accessToken.length < 16 ||
        r.accessToken.length > 8192 ||
        /\s/.test(r.accessToken) ||
        typeof r.sellerId !== 'string' ||
        !SAFE.test(r.sellerId) ||
        !Array.isArray(r.scopes))
        deny('CREDENTIAL_PACKET_INVALID');
    const issued = Date.parse(String(r.issuedAtUtc));
    const expires = Date.parse(String(r.expiresAtUtc));
    if (!Number.isFinite(issued) ||
        !Number.isFinite(expires) ||
        issued > now.getTime() + 30_000 ||
        expires <= now.getTime() + 120_000 ||
        expires - issued > 2 * 60 * 60_000)
        deny('CREDENTIAL_PACKET_EXPIRED');
    const required = [
        'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
        'https://api.ebay.com/oauth/api_scope/sell.inventory',
        'https://api.ebay.com/oauth/api_scope/sell.account',
    ];
    const scopes = r.scopes;
    if (scopes.length !== required.length || !required.every((s) => scopes.includes(s)))
        deny('CREDENTIAL_SCOPE_INVALID');
    return Object.freeze({
        accessToken: r.accessToken,
        sellerId: r.sellerId,
        scopes: Object.freeze([...required]),
        issuedAtUtc: new Date(issued).toISOString(),
        expiresAtUtc: new Date(expires).toISOString(),
    });
}
/** Opaque, migration-scope-safe pseudonym; the private Sandbox seller id is never persisted. */
export function sellerDigest(sellerId) {
    return `sandbox_${createHash('sha256').update(`sandbox-seller:${sellerId}`).digest('hex').slice(0, 55)}`;
}
export function createSandboxAdapter(input) {
    const fetchImpl = input.fetchImpl ?? fetch;
    const now = input.now ?? (() => new Date());
    let bulkAlignmentConsumed = false;
    async function request(url, init) {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' ||
            ![new URL(SANDBOX_API_ORIGIN).hostname, new URL(SANDBOX_IDENTITY_ORIGIN).hostname].includes(parsed.hostname) ||
            parsed.hostname === 'api.ebay.com' ||
            parsed.username ||
            parsed.password ||
            parsed.port ||
            parsed.hash)
            deny('PRODUCTION_HOST_DENIED');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), TIMEOUT);
        try {
            const response = await fetchImpl(url, {
                ...init,
                redirect: 'error',
                signal: controller.signal,
            });
            const declared = Number(response.headers.get('content-length') ?? '0');
            if (declared > MAX)
                deny('RESPONSE_TOO_LARGE');
            const body = await response.text();
            if (Buffer.byteLength(body) > MAX)
                deny('RESPONSE_TOO_LARGE');
            return { status: response.status, body };
        }
        catch (e) {
            if (e instanceof SandboxAdapterError)
                throw e;
            return deny('TRANSPORT_FAILED');
        }
        finally {
            clearTimeout(timeout);
        }
    }
    const json = (body) => {
        try {
            const v = JSON.parse(body);
            if (!v || typeof v !== 'object' || Array.isArray(v))
                return deny('RESPONSE_INVALID');
            return v;
        }
        catch (e) {
            if (e instanceof SandboxAdapterError)
                throw e;
            return deny('RESPONSE_INVALID');
        }
    };
    const headers = () => ({
        Authorization: `Bearer ${input.token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Content-Language': 'en-US',
    });
    async function verifyIdentity() {
        const response = await request(`${SANDBOX_IDENTITY_ORIGIN}/commerce/identity/v1/user/`, {
            method: 'GET',
            headers: headers(),
        });
        const identity = response.status === 200 ? json(response.body) : null;
        if (!identity ||
            identity.userId !== input.expectedSellerId ||
            identity.registrationMarketplaceId !== SANDBOX_MARKETPLACE)
            deny('SELLER_IDENTITY_MISMATCH');
    }
    async function validatePrerequisites(manifest) {
        const listing = manifest.listing;
        const locationResponse = await request(`${SANDBOX_API_ORIGIN}/sell/inventory/v1/location/${encodeURIComponent(listing.merchantLocationKey)}`, { method: 'GET', headers: headers() });
        const location = locationResponse.status === 200 ? json(locationResponse.body) : null;
        if (!location ||
            location.merchantLocationKey !== listing.merchantLocationKey ||
            location.merchantLocationStatus !== 'ENABLED')
            deny('SANDBOX_LOCATION_INVALID');
        const policies = [
            ['fulfillment_policy', listing.fulfillmentPolicyId, 'fulfillmentPolicyId'],
            ['payment_policy', listing.paymentPolicyId, 'paymentPolicyId'],
            ['return_policy', listing.returnPolicyId, 'returnPolicyId'],
        ];
        for (const [resource, id, idField] of policies) {
            const response = await request(`${SANDBOX_API_ORIGIN}/sell/account/v1/${resource}/${encodeURIComponent(id)}`, { method: 'GET', headers: headers() });
            const policy = response.status === 200 ? json(response.body) : null;
            if (!policy || policy[idField] !== id || policy.marketplaceId !== SANDBOX_MARKETPLACE)
                deny('SANDBOX_POLICY_INVALID');
        }
    }
    async function snapshot(sku) {
        if (!SAFE.test(sku))
            deny('TARGET_INVALID');
        const item = await request(`${SANDBOX_API_ORIGIN}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, { method: 'GET', headers: headers() });
        if (item.status !== 200 && item.status !== 404)
            deny('READ_FAILED');
        let inventory = null;
        if (item.status === 200) {
            const body = json(item.body);
            if (body.sku !== sku)
                deny('AMBIGUOUS_REMOTE_STATE');
            const availability = object(body.availability);
            const ship = object(availability.shipToLocationAvailability);
            const product = object(body.product);
            if (!Array.isArray(product.imageUrls) ||
                product.imageUrls.some((url) => typeof url !== 'string'))
                deny('AMBIGUOUS_REMOTE_STATE');
            inventory = Object.freeze({
                sku,
                availability: Object.freeze({
                    shipToLocationAvailability: Object.freeze({
                        quantity: exactInteger(ship.quantity),
                    }),
                }),
                condition: exactText(body.condition, 64),
                conditionDescription: exactText(body.conditionDescription, 1000),
                product: Object.freeze({
                    title: exactText(product.title, 80),
                    description: exactText(product.description),
                    imageUrls: Object.freeze([...product.imageUrls]),
                }),
            });
        }
        const offersResponse = await request(`${SANDBOX_API_ORIGIN}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${SANDBOX_MARKETPLACE}&limit=25&offset=0`, { method: 'GET', headers: headers() });
        if (offersResponse.status !== 200)
            deny('READ_FAILED');
        const offersJson = json(offersResponse.body);
        const total = offersJson.total;
        const rawOffers = offersJson.offers;
        if (!Number.isSafeInteger(total) ||
            Number(total) < 0 ||
            Number(total) > 25 ||
            !Array.isArray(rawOffers) ||
            rawOffers.length !== total)
            deny('AMBIGUOUS_REMOTE_STATE');
        const offers = rawOffers.map((entry) => {
            const e = object(entry);
            const status = String(e.status);
            if (typeof e.offerId !== 'string' ||
                !SAFE.test(e.offerId) ||
                e.sku !== sku ||
                e.marketplaceId !== SANDBOX_MARKETPLACE ||
                e.format !== 'FIXED_PRICE' ||
                e.listingDuration !== 'GTC' ||
                !['PUBLISHED', 'UNPUBLISHED'].includes(status))
                deny('AMBIGUOUS_REMOTE_STATE');
            const listing = e.listing === undefined ? null : object(e.listing);
            const listingId = listing?.listingId;
            if (listingId !== undefined && (typeof listingId !== 'string' || !NUMERIC.test(listingId)))
                deny('RESPONSE_INVALID');
            if (status === 'PUBLISHED' && listingId === undefined)
                deny('AMBIGUOUS_REMOTE_STATE');
            if (status === 'UNPUBLISHED' && listingId !== undefined)
                deny('AMBIGUOUS_REMOTE_STATE');
            const policies = object(e.listingPolicies);
            const pricing = object(e.pricingSummary);
            const price = object(pricing.price);
            return Object.freeze({
                offerId: e.offerId,
                sku,
                marketplaceId: SANDBOX_MARKETPLACE,
                format: 'FIXED_PRICE',
                listingDuration: 'GTC',
                status: status,
                listingId: listingId ?? null,
                availableQuantity: exactInteger(e.availableQuantity),
                categoryId: exactText(e.categoryId, 32),
                listingDescription: exactText(e.listingDescription),
                listingPolicies: Object.freeze({
                    fulfillmentPolicyId: exactText(policies.fulfillmentPolicyId, 128),
                    paymentPolicyId: exactText(policies.paymentPolicyId, 128),
                    returnPolicyId: exactText(policies.returnPolicyId, 128),
                }),
                merchantLocationKey: exactText(e.merchantLocationKey, 128),
                pricingSummary: Object.freeze({
                    price: Object.freeze({
                        currency: exactText(price.currency, 3),
                        value: exactText(price.value, 32),
                    }),
                }),
            });
        });
        const observedAt = now();
        if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime()))
            deny('READ_FAILED');
        const from = new Date(observedAt.getTime() - 5 * 60_000).toISOString();
        const to = new Date(observedAt.getTime() + 119 * 24 * 60 * 60_000).toISOString();
        const xml = `<?xml version="1.0" encoding="utf-8"?><GetSellerListRequest xmlns="urn:ebay:apis:eBLBaseComponents"><DetailLevel>ReturnAll</DetailLevel><ErrorLanguage>en_US</ErrorLanguage><EndTimeFrom>${from}</EndTimeFrom><EndTimeTo>${to}</EndTimeTo><IncludeVariations>true</IncludeVariations><SKUArray><SKU>${sku.replace(/[&<>"']/g, '')}</SKU></SKUArray><Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>1</PageNumber></Pagination><WarningLevel>High</WarningLevel></GetSellerListRequest>`;
        const trading = await request(`${SANDBOX_API_ORIGIN}/ws/api.dll`, {
            method: 'POST',
            headers: {
                'X-EBAY-API-IAF-TOKEN': input.token,
                'X-EBAY-API-CALL-NAME': 'GetSellerList',
                'X-EBAY-API-SITEID': '0',
                'X-EBAY-API-COMPATIBILITY-LEVEL': '1455',
                'Content-Type': 'text/xml',
            },
            body: xml,
        });
        if (trading.status !== 200 ||
            !/<Ack>(?:Success|Warning)<\/Ack>/i.test(trading.body) ||
            /<HasMoreItems>true<\/HasMoreItems>/i.test(trading.body))
            deny('AMBIGUOUS_REMOTE_STATE');
        const totals = [
            ...trading.body.matchAll(/<TotalNumberOfEntries>([0-9]+)<\/TotalNumberOfEntries>/gi),
        ];
        if (totals.length !== 1 ||
            !Number.isSafeInteger(Number(totals[0]?.[1])) ||
            Number(totals[0]?.[1]) > 1)
            deny('AMBIGUOUS_REMOTE_STATE');
        const itemBlocks = [...trading.body.matchAll(/<Item>([\s\S]*?)<\/Item>/gi)].map((match) => match[1] ?? '');
        if (itemBlocks.length !== Number(totals[0]?.[1]))
            deny('AMBIGUOUS_REMOTE_STATE');
        const tradingListings = itemBlocks.map((block) => {
            const money = [
                ...block.matchAll(/<CurrentPrice\s+currencyID="([A-Z]{3})">([^<]+)<\/CurrentPrice>/gi),
            ];
            if (money.length !== 1)
                deny('AMBIGUOUS_REMOTE_STATE');
            const observedSku = xmlText(block, 'SKU');
            if (observedSku !== sku)
                deny('AMBIGUOUS_REMOTE_STATE');
            const quantity = Number(xmlText(block, 'Quantity'));
            if (!Number.isSafeInteger(quantity) || quantity < 0)
                deny('AMBIGUOUS_REMOTE_STATE');
            const itemId = xmlText(block, 'ItemID');
            if (!NUMERIC.test(itemId))
                deny('AMBIGUOUS_REMOTE_STATE');
            return Object.freeze({
                itemId,
                sku: observedSku,
                title: xmlText(block, 'Title'),
                description: xmlText(block, 'Description'),
                quantity,
                categoryId: xmlText(block, 'CategoryID'),
                price: money[0]?.[2] ?? '',
                currency: money[0]?.[1] ?? '',
                listingStatus: (() => {
                    const status = xmlText(block, 'ListingStatus');
                    if (!['Active', 'Completed', 'Ended'].includes(status))
                        deny('AMBIGUOUS_REMOTE_STATE');
                    return status;
                })(),
            });
        });
        return Object.freeze({
            inventory,
            offers: Object.freeze(offers),
            tradingListings: Object.freeze(tradingListings),
        });
    }
    async function putInventory(sku, payload) {
        const r = await request(`${SANDBOX_API_ORIGIN}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, { method: 'PUT', headers: headers(), body: JSON.stringify(payload) });
        if (![200, 201, 204].includes(r.status))
            deny('WRITE_FAILED');
    }
    async function createOffer(payload) {
        const r = await request(`${SANDBOX_API_ORIGIN}/sell/inventory/v1/offer`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify(payload),
        });
        const id = r.status === 200 || r.status === 201 ? json(r.body).offerId : null;
        if (typeof id !== 'string' || !SAFE.test(id))
            return deny('WRITE_FAILED');
        return id;
    }
    async function publish(offerId) {
        if (!SAFE.test(offerId))
            deny('TARGET_INVALID');
        const r = await request(`${SANDBOX_API_ORIGIN}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`, { method: 'POST', headers: headers(), body: '{}' });
        const id = r.status === 200 ? json(r.body).listingId : null;
        if (typeof id !== 'string' || !NUMERIC.test(id))
            return deny('WRITE_FAILED');
        return id;
    }
    async function withdraw(offerId) {
        if (!SAFE.test(offerId))
            deny('TARGET_INVALID');
        const r = await request(`${SANDBOX_API_ORIGIN}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`, { method: 'POST', headers: headers(), body: '{}' });
        if (![200, 204].includes(r.status))
            deny('WRITE_FAILED');
    }
    async function deleteOffer(offerId) {
        const r = await request(`${SANDBOX_API_ORIGIN}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, { method: 'DELETE', headers: headers() });
        if (![200, 204].includes(r.status))
            deny('WRITE_FAILED');
    }
    async function deleteInventory(sku) {
        const r = await request(`${SANDBOX_API_ORIGIN}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, { method: 'DELETE', headers: headers() });
        if (![200, 204].includes(r.status))
            deny('WRITE_FAILED');
    }
    async function bulkUpdatePriceQuantity(alignment) {
        if (bulkAlignmentConsumed)
            deny('WRITE_CAPABILITY_CONSUMED');
        bulkAlignmentConsumed = true;
        const body = buildSandboxBulkUpdateBody(alignment);
        const r = await request(`${SANDBOX_API_ORIGIN}/sell/inventory/v1/bulk_update_price_quantity`, {
            method: 'POST', headers: headers(), body,
        });
        const response = r.status === 200 ? json(r.body) : null;
        if (!response || !Array.isArray(response.responses) || response.responses.length !== 1
            || object(response.responses[0]).statusCode !== 200)
            deny('WRITE_FAILED');
    }
    return Object.freeze({
        verifyIdentity,
        validatePrerequisites,
        snapshot,
        putInventory,
        createOffer,
        publish,
        withdraw,
        deleteOffer,
        deleteInventory,
        bulkUpdatePriceQuantity,
    });
}
