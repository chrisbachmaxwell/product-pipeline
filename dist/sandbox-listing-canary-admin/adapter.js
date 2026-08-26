import { createHash } from 'node:crypto';
import { SANDBOX_API_ORIGIN, SANDBOX_IDENTITY_ORIGIN, SANDBOX_MARKETPLACE } from './manifest.js';
const MAX = 2 * 1024 * 1024;
const TIMEOUT = 20_000;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NUMERIC = /^[0-9]{1,20}$/;
export class SandboxAdapterError extends Error {
    code;
    constructor(code) {
        super('Sandbox provider operation denied');
        this.code = code;
        this.name = 'SandboxAdapterError';
    }
}
const deny = (code) => { throw new SandboxAdapterError(code); };
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
    if (Object.keys(r).sort().join('|') !== ['accessToken', 'expiresAtUtc', 'issuedAtUtc', 'scopes', 'sellerId'].sort().join('|')
        || typeof r.accessToken !== 'string' || r.accessToken.length < 16 || r.accessToken.length > 8192 || /\s/.test(r.accessToken)
        || typeof r.sellerId !== 'string' || !SAFE.test(r.sellerId) || !Array.isArray(r.scopes))
        deny('CREDENTIAL_PACKET_INVALID');
    const issued = Date.parse(String(r.issuedAtUtc));
    const expires = Date.parse(String(r.expiresAtUtc));
    if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > now.getTime() + 30_000 || expires <= now.getTime() + 120_000 || expires - issued > 2 * 60 * 60_000)
        deny('CREDENTIAL_PACKET_EXPIRED');
    const required = ['https://api.ebay.com/oauth/api_scope/commerce.identity.readonly', 'https://api.ebay.com/oauth/api_scope/sell.inventory'];
    const scopes = r.scopes;
    if (scopes.length !== required.length || !required.every((s) => scopes.includes(s)))
        deny('CREDENTIAL_SCOPE_INVALID');
    return Object.freeze({ accessToken: r.accessToken, sellerId: r.sellerId, scopes: Object.freeze([...required]), issuedAtUtc: new Date(issued).toISOString(), expiresAtUtc: new Date(expires).toISOString() });
}
/** Opaque, migration-scope-safe pseudonym; the private Sandbox seller id is never persisted. */
export function sellerDigest(sellerId) { return `sandbox_${createHash('sha256').update(`sandbox-seller:${sellerId}`).digest('hex').slice(0, 55)}`; }
export function createSandboxAdapter(input) {
    const fetchImpl = input.fetchImpl ?? fetch;
    const now = input.now ?? (() => new Date());
    async function request(url, init) {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || ![new URL(SANDBOX_API_ORIGIN).hostname, new URL(SANDBOX_IDENTITY_ORIGIN).hostname].includes(parsed.hostname)
            || parsed.hostname === 'api.ebay.com' || parsed.username || parsed.password || parsed.port || parsed.hash)
            deny('PRODUCTION_HOST_DENIED');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), TIMEOUT);
        try {
            const response = await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal });
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
    const json = (body) => { try {
        const v = JSON.parse(body);
        if (!v || typeof v !== 'object' || Array.isArray(v))
            return deny('RESPONSE_INVALID');
        return v;
    }
    catch (e) {
        if (e instanceof SandboxAdapterError)
            throw e;
        return deny('RESPONSE_INVALID');
    } };
    const headers = () => ({ Authorization: `Bearer ${input.token}`, Accept: 'application/json', 'Content-Type': 'application/json', 'Content-Language': 'en-US' });
    async function verifyIdentity() {
        const response = await request(`${SANDBOX_IDENTITY_ORIGIN}/commerce/identity/v1/user/`, { method: 'GET', headers: headers() });
        const identity = response.status === 200 ? json(response.body) : null;
        if (!identity || identity.userId !== input.expectedSellerId || identity.registrationMarketplaceId !== SANDBOX_MARKETPLACE)
            deny('SELLER_IDENTITY_MISMATCH');
    }
    async function snapshot(sku) {
        if (!SAFE.test(sku))
            deny('TARGET_INVALID');
        const item = await request(`${SANDBOX_API_ORIGIN}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, { method: 'GET', headers: headers() });
        if (item.status !== 200 && item.status !== 404)
            deny('READ_FAILED');
        if (item.status === 200 && json(item.body).sku !== sku)
            deny('AMBIGUOUS_REMOTE_STATE');
        const offersResponse = await request(`${SANDBOX_API_ORIGIN}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${SANDBOX_MARKETPLACE}&limit=25&offset=0`, { method: 'GET', headers: headers() });
        if (offersResponse.status !== 200)
            deny('READ_FAILED');
        const offersJson = json(offersResponse.body);
        const total = offersJson.total;
        const rawOffers = offersJson.offers;
        if (!Number.isSafeInteger(total) || Number(total) < 0 || Number(total) > 25 || !Array.isArray(rawOffers) || rawOffers.length !== total)
            deny('AMBIGUOUS_REMOTE_STATE');
        const offers = rawOffers.map((entry) => { if (!entry || typeof entry !== 'object' || Array.isArray(entry))
            return deny('RESPONSE_INVALID'); const e = entry; if (typeof e.offerId !== 'string' || !SAFE.test(e.offerId) || e.sku !== sku || e.marketplaceId !== SANDBOX_MARKETPLACE || !['PUBLISHED', 'UNPUBLISHED'].includes(String(e.status)))
            return deny('AMBIGUOUS_REMOTE_STATE'); const listing = e.listing; const listingId = listing && typeof listing === 'object' && !Array.isArray(listing) ? listing.listingId : undefined; if (listingId !== undefined && (typeof listingId !== 'string' || !NUMERIC.test(listingId)))
            return deny('RESPONSE_INVALID'); if (e.status === 'PUBLISHED' && listingId === undefined)
            deny('AMBIGUOUS_REMOTE_STATE'); if (e.status === 'UNPUBLISHED' && listingId !== undefined)
            deny('AMBIGUOUS_REMOTE_STATE'); return Object.freeze({ offerId: e.offerId, status: e.status, listingId: listingId ?? null }); });
        const observedAt = now();
        if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime()))
            deny('READ_FAILED');
        const from = new Date(observedAt.getTime() - 5 * 60_000).toISOString();
        const to = new Date(observedAt.getTime() + 119 * 24 * 60 * 60_000).toISOString();
        const xml = `<?xml version="1.0" encoding="utf-8"?><GetSellerListRequest xmlns="urn:ebay:apis:eBLBaseComponents"><DetailLevel>ReturnAll</DetailLevel><ErrorLanguage>en_US</ErrorLanguage><EndTimeFrom>${from}</EndTimeFrom><EndTimeTo>${to}</EndTimeTo><IncludeVariations>true</IncludeVariations><SKUArray><SKU>${sku.replace(/[&<>"']/g, '')}</SKU></SKUArray><Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>1</PageNumber></Pagination><WarningLevel>High</WarningLevel></GetSellerListRequest>`;
        const trading = await request(`${SANDBOX_API_ORIGIN}/ws/api.dll`, { method: 'POST', headers: { 'X-EBAY-API-IAF-TOKEN': input.token, 'X-EBAY-API-CALL-NAME': 'GetSellerList', 'X-EBAY-API-SITEID': '0', 'X-EBAY-API-COMPATIBILITY-LEVEL': '1455', 'Content-Type': 'text/xml' }, body: xml });
        if (trading.status !== 200 || !/<Ack>(?:Success|Warning)<\/Ack>/i.test(trading.body) || /<HasMoreItems>true<\/HasMoreItems>/i.test(trading.body))
            deny('AMBIGUOUS_REMOTE_STATE');
        const totals = [...trading.body.matchAll(/<TotalNumberOfEntries>([0-9]+)<\/TotalNumberOfEntries>/gi)];
        if (totals.length !== 1 || !Number.isSafeInteger(Number(totals[0]?.[1])))
            deny('AMBIGUOUS_REMOTE_STATE');
        const matches = [...trading.body.matchAll(/<SKU>([^<]*)<\/SKU>/gi)].filter((m) => m[1] === sku).length;
        if (matches !== Number(totals[0]?.[1]))
            deny('AMBIGUOUS_REMOTE_STATE');
        return Object.freeze({ inventoryPresent: item.status === 200, offers: Object.freeze(offers), tradingSkuMatches: matches });
    }
    async function putInventory(sku, payload) { const r = await request(`${SANDBOX_API_ORIGIN}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, { method: 'PUT', headers: headers(), body: JSON.stringify(payload) }); if (![200, 201, 204].includes(r.status))
        deny('WRITE_FAILED'); }
    async function createOffer(payload) { const r = await request(`${SANDBOX_API_ORIGIN}/sell/inventory/v1/offer`, { method: 'POST', headers: headers(), body: JSON.stringify(payload) }); const id = r.status === 200 || r.status === 201 ? json(r.body).offerId : null; if (typeof id !== 'string' || !SAFE.test(id))
        return deny('WRITE_FAILED'); return id; }
    async function publish(offerId) { if (!SAFE.test(offerId))
        deny('TARGET_INVALID'); const r = await request(`${SANDBOX_API_ORIGIN}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`, { method: 'POST', headers: headers(), body: '{}' }); const id = r.status === 200 ? json(r.body).listingId : null; if (typeof id !== 'string' || !NUMERIC.test(id))
        return deny('WRITE_FAILED'); return id; }
    async function withdraw(offerId) { if (!SAFE.test(offerId))
        deny('TARGET_INVALID'); const r = await request(`${SANDBOX_API_ORIGIN}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/withdraw`, { method: 'POST', headers: headers(), body: '{}' }); if (![200, 204].includes(r.status))
        deny('WRITE_FAILED'); }
    async function deleteOffer(offerId) { const r = await request(`${SANDBOX_API_ORIGIN}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`, { method: 'DELETE', headers: headers() }); if (![200, 204].includes(r.status))
        deny('WRITE_FAILED'); }
    async function deleteInventory(sku) { const r = await request(`${SANDBOX_API_ORIGIN}/sell/inventory/v1/inventory_item/${encodeURIComponent(sku)}`, { method: 'DELETE', headers: headers() }); if (![200, 204].includes(r.status))
        deny('WRITE_FAILED'); }
    return Object.freeze({ verifyIdentity, snapshot, putInventory, createOffer, publish, withdraw, deleteOffer, deleteInventory });
}
