import { describe, expect, it, vi } from 'vitest';
import { createEnrichedListingDetailReader, EBAY_LISTING_DETAIL_MARKETPLACE_ID, EBAY_LISTING_DETAIL_SELLER_ID, ENRICHED_LISTING_DETAIL_TESTING, EnrichedListingDetailError, parseInventoryOfferControl, parseTradingItemDetail, } from './enriched-listing-detail.js';
const listingId = '123456789012';
const sku = 'CAN3570-U119';
const offerId = 'v1|123456789012|0';
const token = 'transient-secret-authority';
const observedAt = new Date('2026-08-13T22:00:00.000Z');
const requestBase = {
    accessToken: token,
    sellerId: EBAY_LISTING_DETAIL_SELLER_ID,
    marketplaceId: EBAY_LISTING_DETAIL_MARKETPLACE_ID,
    mappingState: 'mapped',
    shopifyProductId: 'gid://shopify/Product/100',
    shopifyVariantId: 'gid://shopify/ProductVariant/200',
    sku,
    listingId,
};
function getUserXml(userId = 'usedcameragear') {
    return `<?xml version="1.0" encoding="utf-8"?>
    <GetUserResponse xmlns="urn:ebay:apis:eBLBaseComponents">
      <Ack>Success</Ack><User><UserID>${userId}</UserID><Email>private@example.com</Email></User>
    </GetUserResponse>`;
}
function getItemXml(overrides = {}) {
    return `<?xml version="1.0" encoding="utf-8"?>
    <GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents">
      <Ack>Success</Ack>
      <Item>
        <ItemID>${overrides.itemId ?? listingId}</ItemID>
        <SKU>${overrides.itemSku ?? sku}</SKU>
        <Seller><UserID>${overrides.sellerId ?? 'UsedCameraGear'}</UserID><Email>seller-private@example.com</Email></Seller>
        <Title>Canon 35-70mm f/3.5-4.5 (#119) *USED*</Title>
        <Description>${overrides.description ?? '&lt;p&gt;Exact public description&lt;/p&gt;'}</Description>
        <ListingType>FixedPriceItem</ListingType><ListingDuration>GTC</ListingDuration>
        <PrimaryCategory><CategoryID>3323</CategoryID><CategoryName>Camera Lenses</CategoryName></PrimaryCategory>
        <ConditionID>3000</ConditionID><ConditionDisplayName>Used</ConditionDisplayName>
        <ConditionDescription>Minor wear. Glass is clean.</ConditionDescription>
        <ConditionDescriptors><ConditionDescriptor><Name>Type</Name><Value>Used</Value><AdditionalInfo>Inspected</AdditionalInfo></ConditionDescriptor></ConditionDescriptors>
        <ItemSpecifics>
          <NameValueList><Name>Brand</Name><Value>Canon</Value></NameValueList>
          <NameValueList><Name>Compatible Brand</Name><Value>For Canon</Value></NameValueList>
        </ItemSpecifics>
        <ProductListingDetails><UPC>082966214073</UPC><BrandMPN><Brand>Canon</Brand><MPN>3570</MPN></BrandMPN></ProductListingDetails>
        <PictureDetails><PictureURL>${overrides.imageUrl ?? 'https://i.ebayimg.com/images/g/example/s-l1600.jpg'}</PictureURL></PictureDetails>
        <SellingStatus><ListingStatus>Active</ListingStatus><CurrentPrice currencyID="USD">39.95</CurrentPrice><QuantitySold>0</QuantitySold></SellingStatus>
        <Quantity>1</Quantity><QuantityAvailable>1</QuantityAvailable>
        <BestOfferDetails><BestOfferEnabled>true</BestOfferEnabled></BestOfferDetails>
        <ListingDetails><StartTime>2026-08-13T20:00:00.000Z</StartTime><EndTime>2026-09-12T20:00:00.000Z</EndTime><ViewItemURL>https://www.ebay.com/itm/${listingId}</ViewItemURL></ListingDetails>
        <SellerProfiles>
          <SellerShippingProfile><ShippingProfileID>101</ShippingProfileID></SellerShippingProfile>
          <SellerPaymentProfile><PaymentProfileID>102</PaymentProfileID></SellerPaymentProfile>
          <SellerReturnProfile><ReturnProfileID>103</ReturnProfileID></SellerReturnProfile>
        </SellerProfiles>
        <ShippingDetails><ShippingType>Flat</ShippingType><ShippingServiceOptions><ShippingService>USPSGround</ShippingService></ShippingServiceOptions></ShippingDetails>
        <ReturnPolicy><ReturnsAcceptedOption>ReturnsAccepted</ReturnsAcceptedOption><ReturnsWithinOption>Days_30</ReturnsWithinOption><ShippingCostPaidByOption>Buyer</ShippingCostPaidByOption></ReturnPolicy>
        <Location>Draper, Utah</Location><Country>US</Country>
        <PrivateNotes>Bearer should-never-escape</PrivateNotes>
        <BuyerRequirementDetails><LinkedPayPalAccount>true</LinkedPayPalAccount></BuyerRequirementDetails>
      </Item>
    </GetItemResponse>`;
}
function xmlResponse(body, init = {}) {
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/xml' }, ...init });
}
function jsonResponse(body) {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}
function inventoryItem() {
    return {
        sku,
        condition: 'USED_EXCELLENT',
        conditionDescription: 'Control record condition',
        conditionDescriptors: [{ name: 'Type', values: ['Used'], additionalInfo: 'Inspected' }],
        availability: { shipToLocationAvailability: { quantity: 1 } },
        product: {
            title: 'Canon 35-70mm control title',
            description: '<p>Inventory item description</p>',
            imageUrls: ['https://cdn.shopify.com/s/files/1/example.jpg'],
            aspects: { Brand: ['Canon'], MPN: ['3570'] },
            brand: 'Canon',
            mpn: '3570',
            upc: ['082966214073'],
        },
        buyerData: { email: 'must-not-escape@example.com' },
    };
}
function offer(overrides = {}) {
    return {
        offerId,
        sku,
        marketplaceId: 'EBAY_US',
        status: 'PUBLISHED',
        listing: {
            listingId,
            listingStatus: 'ACTIVE',
            listingOnHold: false,
            soldQuantity: 0,
        },
        format: 'FIXED_PRICE',
        listingDuration: 'GTC',
        listingDescription: '<p>Offer description</p>',
        categoryId: '3323',
        pricingSummary: { price: { value: '39.95', currency: 'USD' } },
        availableQuantity: 1,
        quantityLimitPerBuyer: 1,
        listingPolicies: {
            fulfillmentPolicyId: '101',
            paymentPolicyId: '102',
            returnPolicyId: '103',
            bestOfferTerms: { bestOfferEnabled: true },
        },
        merchantLocationKey: 'used-camera-gear',
        privateSellerNote: 'must-not-escape',
        ...overrides,
    };
}
function legacyRequest() {
    return { ...requestBase, management: { model: 'legacy_trading' } };
}
describe('enriched eBay listing detail reader', () => {
    it('captures minimized legacy Trading actuals with exact read-only calls and redaction', async () => {
        const calls = [];
        const fetchImpl = vi.fn(async (url, init) => {
            calls.push({ url: String(url), init });
            const callName = new Headers(init?.headers).get('X-EBAY-API-CALL-NAME');
            return callName === 'GetUser' ? xmlResponse(getUserXml()) : xmlResponse(getItemXml());
        });
        const result = await createEnrichedListingDetailReader({
            fetchImpl,
            now: () => observedAt,
        })(legacyRequest());
        expect(result).toMatchObject({
            schemaVersion: 1,
            evidence: {
                observedAtUtc: observedAt.toISOString(),
                complete: true,
                remoteReadPerformed: true,
                externalWritesPerformed: 0,
                requestCount: 2,
            },
            identity: { sellerId: 'usedcameragear', sku, listingId, offerId: null },
            actual: {
                lifecycle: { status: 'ACTIVE', active: true, format: 'FixedPriceItem', duration: 'GTC' },
                content: { title: 'Canon 35-70mm f/3.5-4.5 (#119) *USED*' },
                category: { primary: { id: '3323', name: 'Camera Lenses' } },
                condition: { id: '3000', name: 'Used' },
                aspects: { Brand: ['Canon'], 'Compatible Brand': ['For Canon'] },
                identifiers: { brand: 'Canon', mpn: '3570', upc: ['082966214073'] },
                commerce: {
                    price: { value: '39.95', currency: 'USD' },
                    availableQuantity: 1,
                    availableQuantityBasis: 'reported',
                },
                policies: {
                    fulfillmentPolicyId: '101', paymentPolicyId: '102', returnPolicyId: '103',
                },
            },
            management: { model: 'legacy_trading', controlApi: 'trading', lifecycleAligned: true },
        });
        expect(calls).toHaveLength(2);
        expect(calls.every((call) => call.url === 'https://api.ebay.com/ws/api.dll')).toBe(true);
        expect(calls.every((call) => call.init?.method === 'POST' && call.init.redirect === 'error')).toBe(true);
        expect(calls.map((call) => new Headers(call.init?.headers).get('X-EBAY-API-CALL-NAME')))
            .toEqual(['GetUser', 'GetItem']);
        expect(String(calls[1].init?.body)).toContain(`<ItemID>${listingId}</ItemID>`);
        const serialized = JSON.stringify(result);
        expect(serialized).not.toMatch(/transient-secret|private@example|seller-private|PrivateNotes|BuyerRequirement|should-never-escape/i);
    });
    it('captures Inventory item and exact offer control without replacing public Trading actuals', async () => {
        const calls = [];
        const fetchImpl = vi.fn(async (url, init) => {
            calls.push({ url: String(url), init });
            if (String(url).endsWith(`/inventory_item/${sku}`))
                return jsonResponse(inventoryItem());
            if (String(url).includes('/sell/inventory/v1/offer/'))
                return jsonResponse(offer());
            const callName = new Headers(init?.headers).get('X-EBAY-API-CALL-NAME');
            return callName === 'GetUser' ? xmlResponse(getUserXml()) : xmlResponse(getItemXml());
        });
        const result = await createEnrichedListingDetailReader({ fetchImpl, now: () => observedAt })({
            ...requestBase,
            management: { model: 'inventory_offer', offerId },
        });
        expect(result.evidence.requestCount).toBe(4);
        expect(result.actual.content.title).toBe('Canon 35-70mm f/3.5-4.5 (#119) *USED*');
        expect(result.management).toMatchObject({
            model: 'inventory_offer',
            controlApi: 'inventory',
            lifecycleAligned: true,
            exactBindings: {
                seller: true, listing: true, sku: true, inventoryItem: true, offer: true, offerToListing: true,
            },
            inventoryItem: { sku, content: { title: 'Canon 35-70mm control title' } },
            offer: {
                offerId, sku, marketplaceId: 'EBAY_US', status: 'PUBLISHED', listingStatus: 'ACTIVE',
                primaryCategoryId: '3323', fulfillmentPolicyId: '101', merchantLocationKey: 'used-camera-gear',
            },
        });
        const inventoryCalls = calls.filter((call) => call.url.includes('/sell/inventory/v1/'));
        expect(inventoryCalls).toHaveLength(2);
        expect(inventoryCalls.every((call) => call.init?.method === 'GET'
            && new Headers(call.init.headers).get('Authorization') === `Bearer ${token}`)).toBe(true);
        expect(JSON.stringify(result)).not.toMatch(/buyerData|privateSellerNote|must-not-escape/i);
    });
    it.each([
        ['SELLER_MISMATCH', () => parseTradingItemDetail({ Item: { ItemID: listingId, SKU: sku, Seller: { UserID: 'wrong-seller' } } }, { sellerId: 'usedcameragear', listingId, sku })],
        ['LISTING_MISMATCH', () => parseTradingItemDetail({ Item: { ItemID: '999', SKU: sku, Seller: { UserID: 'usedcameragear' } } }, { sellerId: 'usedcameragear', listingId, sku })],
        ['SKU_MISMATCH', () => parseTradingItemDetail({ Item: { ItemID: listingId, SKU: `${sku} `, Seller: { UserID: 'usedcameragear' } } }, { sellerId: 'usedcameragear', listingId, sku })],
        ['OFFER_MISMATCH', () => parseInventoryOfferControl(offer({ offerId: 'wrong-offer' }), { offerId, sku, listingId, marketplaceId: 'EBAY_US' })],
        ['LISTING_MISMATCH', () => parseInventoryOfferControl(offer({ listing: { listingId: '999', listingStatus: 'ACTIVE' } }), { offerId, sku, listingId, marketplaceId: 'EBAY_US' })],
    ])('fails closed with %s on an exact binding adversary', (code, operation) => {
        expect(operation).toThrow(expect.objectContaining({ code }));
    });
    it('supports an exact variation SKU and rejects duplicate item/variation bindings', async () => {
        const variationResponse = {
            Item: {
                ItemID: listingId,
                Seller: { UserID: 'usedcameragear' },
                Title: 'Multi variation listing',
                ListingType: 'FixedPriceItem',
                ListingDuration: 'GTC',
                PrimaryCategory: { CategoryID: '3323' },
                SellingStatus: { ListingStatus: 'Active' },
                Variations: {
                    Variation: {
                        SKU: sku,
                        StartPrice: { value: '39.95', currency: 'USD' },
                        Quantity: '1',
                        SellingStatus: { ListingStatus: 'Active', QuantitySold: '0' },
                        VariationSpecifics: { NameValueList: { Name: 'Focal Length', Value: '35-70mm' } },
                    },
                },
            },
        };
        expect(parseTradingItemDetail(variationResponse, {
            sellerId: 'usedcameragear', listingId, sku,
        }).actual.aspects).toEqual({ 'Focal Length': ['35-70mm'] });
        expect(() => parseTradingItemDetail({
            Item: { ...variationResponse.Item, SKU: sku },
        }, { sellerId: 'usedcameragear', listingId, sku }))
            .toThrow(expect.objectContaining({ code: 'SKU_MISMATCH' }));
    });
    it.each([
        ['DTD', `<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>${getUserXml()}`, 'INVALID_RESPONSE'],
        ['warning', getUserXml().replace('<Ack>Success</Ack>', '<Ack>Warning</Ack>'), 'REMOTE_READ_FAILED'],
        ['redirect', '', 'REMOTE_READ_FAILED'],
    ])('rejects unsafe %s responses without reflecting upstream content', async (mode, body, code) => {
        const fetchImpl = vi.fn(async () => mode === 'redirect'
            ? new Response('', { status: 302, headers: { Location: 'https://evil.example/' } })
            : xmlResponse(body));
        const reader = createEnrichedListingDetailReader({ fetchImpl });
        await expect(reader(legacyRequest())).rejects.toMatchObject({
            name: 'EnrichedListingDetailError', code,
        });
    });
    it('enforces declared and streamed response caps and rejects unsafe render URLs', async () => {
        const oversized = vi.fn(async () => xmlResponse('', {
            headers: { 'Content-Length': String(ENRICHED_LISTING_DETAIL_TESTING.MAX_RESPONSE_BYTES + 1) },
        }));
        await expect(createEnrichedListingDetailReader({ fetchImpl: oversized })(legacyRequest()))
            .rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
        const unsafeImageFetch = (async (_url, init) => {
            return new Headers(init?.headers).get('X-EBAY-API-CALL-NAME') === 'GetUser'
                ? xmlResponse(getUserXml())
                : xmlResponse(getItemXml({ imageUrl: 'https://evil.example/track.jpg?token=secret' }));
        });
        await expect(createEnrichedListingDetailReader({ fetchImpl: unsafeImageFetch })(legacyRequest()))
            .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    });
    it('preserves a 150 KiB eBay description without truncation', async () => {
        const description = 'X'.repeat(150 * 1024);
        const fetchImpl = (async (_url, init) => {
            return new Headers(init?.headers).get('X-EBAY-API-CALL-NAME') === 'GetUser'
                ? xmlResponse(getUserXml())
                : xmlResponse(getItemXml({ description }));
        });
        const result = await createEnrichedListingDetailReader({ fetchImpl })(legacyRequest());
        expect(result.actual.content.descriptionHtml).toBe(description);
        expect(result.actual.content.descriptionHtml).toHaveLength(150 * 1024);
    });
    it('accepts the eBay maximum of 500,000 description characters', async () => {
        const description = 'X'.repeat(ENRICHED_LISTING_DETAIL_TESTING.MAX_DESCRIPTION_CHARACTERS);
        const fetchImpl = (async (_url, init) => {
            return new Headers(init?.headers).get('X-EBAY-API-CALL-NAME') === 'GetUser'
                ? xmlResponse(getUserXml())
                : xmlResponse(getItemXml({ description }));
        });
        const result = await createEnrichedListingDetailReader({ fetchImpl })(legacyRequest());
        expect(result.actual.content.descriptionHtml).toBe(description);
    });
    it('rejects 500,001 description characters', async () => {
        const description = 'X'.repeat(ENRICHED_LISTING_DETAIL_TESTING.MAX_DESCRIPTION_CHARACTERS + 1);
        const fetchImpl = (async (_url, init) => {
            return new Headers(init?.headers).get('X-EBAY-API-CALL-NAME') === 'GetUser'
                ? xmlResponse(getUserXml())
                : xmlResponse(getItemXml({ description }));
        });
        await expect(createEnrichedListingDetailReader({ fetchImpl })(legacyRequest()))
            .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    });
    it('rejects a multibyte description above the separate UTF-8 safety cap', async () => {
        const bytesPerCharacter = Buffer.byteLength('€', 'utf8');
        const description = '€'.repeat(Math.floor(ENRICHED_LISTING_DETAIL_TESTING.MAX_DESCRIPTION_UTF8_BYTES / bytesPerCharacter) + 1);
        expect(Buffer.byteLength(description, 'utf8'))
            .toBeGreaterThan(ENRICHED_LISTING_DETAIL_TESTING.MAX_DESCRIPTION_UTF8_BYTES);
        const fetchImpl = (async (_url, init) => {
            return new Headers(init?.headers).get('X-EBAY-API-CALL-NAME') === 'GetUser'
                ? xmlResponse(getUserXml())
                : xmlResponse(getItemXml({ description }));
        });
        await expect(createEnrichedListingDetailReader({ fetchImpl })(legacyRequest()))
            .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    });
    it('rejects prohibited control characters in a decoded eBay description', () => {
        expect(() => parseInventoryOfferControl(offer({ listingDescription: 'safe\u0001unsafe' }), { offerId, sku, listingId, marketplaceId: 'EBAY_US' })).toThrow(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
    });
    it('uses a fixed generic error surface that never reflects a token or upstream body', () => {
        const error = new EnrichedListingDetailError('REMOTE_READ_FAILED');
        expect(error.message).toBe('Enriched eBay listing detail is unavailable');
        expect(JSON.stringify(error)).not.toMatch(/secret|token|body/i);
    });
    it('represents an eBay-only row without fabricating Shopify identity', async () => {
        const fetchImpl = (async (_url, init) => {
            return new Headers(init?.headers).get('X-EBAY-API-CALL-NAME') === 'GetUser'
                ? xmlResponse(getUserXml())
                : xmlResponse(getItemXml());
        });
        const result = await createEnrichedListingDetailReader({ fetchImpl, now: () => observedAt })({
            ...requestBase,
            mappingState: 'ebay_only_unmapped',
            shopifyProductId: null,
            shopifyVariantId: null,
            management: { model: 'legacy_trading' },
        });
        expect(result.identity).toMatchObject({
            mappingState: 'ebay_only_unmapped',
            shopifyProductId: null,
            shopifyVariantId: null,
        });
    });
});
