/**
 * L105 (incident #198): eBay refused every Shopify price cut on a Trading
 * listing whose Best Offer auto-accept price was at or above the new price
 * (error 23004), so the markdown never reached eBay. The real adapter now
 * answers that rejection with one GetItem read and one bounded
 * ReviseFixedPriceItem carrying the same approved price plus scaled
 * thresholds. Only the HTTP transport is faked; no network access occurs.
 */
import { describe, expect, it } from 'vitest';
import {
  buildRevisePriceWithBestOfferXml,
  createTradingAlignDispatchAdapter,
  planBestOfferThresholds,
  TradingAlignDispatchError,
} from '../trading-dispatch-adapter.js';

const LISTING_ID = '147436215816';
const usd = (value: string) => ({ value, currency: 'USD' });

const REJECTED_23004 = '<?xml version="1.0" encoding="UTF-8"?>'
  + '<ReviseInventoryStatusResponse xmlns="urn:ebay:apis:eBLBaseComponents">'
  + '<Ack>Failure</Ack><Errors><ShortMessage>Invalid AutoAccept price.</ShortMessage>'
  + '<LongMessage>The Best Offer Auto Accept Price must be less than the Buy It Now price.</LongMessage>'
  + '<ErrorCode>23004</ErrorCode><SeverityCode>Error</SeverityCode>'
  + '<ErrorParameters ParamID="0"><Value>159.95 USD</Value></ErrorParameters>'
  + `<ErrorParameters ParamID="1"><Value>${LISTING_ID}</Value></ErrorParameters>`
  + '<ErrorParameters ParamID="2"><Value>AFF050S-700-U029</Value></ErrorParameters>'
  + '<ErrorClassification>RequestError</ErrorClassification></Errors>'
  + '</ReviseInventoryStatusResponse>';

const REJECTED_OTHER = '<?xml version="1.0" encoding="UTF-8"?>'
  + '<ReviseInventoryStatusResponse xmlns="urn:ebay:apis:eBLBaseComponents">'
  + '<Ack>Failure</Ack><Errors><ShortMessage>Item cannot be accessed.</ShortMessage>'
  + '<ErrorCode>17</ErrorCode><SeverityCode>Error</SeverityCode></Errors>'
  + '</ReviseInventoryStatusResponse>';

function getItemResponse(options: { autoAccept?: string; minimum?: string; startPrice?: string } = {}): string {
  const details = [
    options.autoAccept === undefined ? ''
      : `<BestOfferAutoAcceptPrice currencyID="USD">${options.autoAccept}</BestOfferAutoAcceptPrice>`,
    options.minimum === undefined ? ''
      : `<MinimumBestOfferPrice currencyID="USD">${options.minimum}</MinimumBestOfferPrice>`,
  ].join('');
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><Item>'
    + `<ItemID>${LISTING_ID}</ItemID>`
    + `<StartPrice currencyID="USD">${options.startPrice ?? '199.95'}</StartPrice>`
    + `<ListingDetails><StartTime>2026-09-01T00:00:00.000Z</StartTime>${details}</ListingDetails>`
    + '</Item></GetItemResponse>';
}

const SUCCESS = (call: string) => '<?xml version="1.0" encoding="UTF-8"?>'
  + `<${call}Response xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack></${call}Response>`;

function world(responses: Record<string, string[]>) {
  const requests: Array<{ call: string; body: string }> = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    const call = headers['X-EBAY-API-CALL-NAME'];
    requests.push({ call, body: String(init?.body) });
    const next = responses[call]?.shift();
    if (next === undefined) throw new Error(`unexpected ${call}`);
    return new Response(next, { status: 200 });
  }) as typeof fetch;
  const adapter = createTradingAlignDispatchAdapter({
    fetchImpl,
    getAccessToken: async () => 'test-token',
  });
  return { adapter, requests };
}

describe('Trading price cut below the Best Offer thresholds (L105, #198)', () => {
  it('re-sends the same price with scaled thresholds after eBay 23004 and succeeds', async () => {
    const { adapter, requests } = world({
      ReviseInventoryStatus: [REJECTED_23004],
      GetItem: [getItemResponse({ autoAccept: '179.95', minimum: '150.00' })],
      ReviseFixedPriceItem: [SUCCESS('ReviseFixedPriceItem')],
    });
    await adapter.reviseInventoryStatus({ listingId: LISTING_ID, field: 'price', price: usd('159.95') });

    expect(requests.map((request) => request.call))
      .toEqual(['ReviseInventoryStatus', 'GetItem', 'ReviseFixedPriceItem']);
    const revise = requests[2].body;
    // Same approved price, thresholds scaled by 159.95/199.95 (rounded down).
    expect(revise).toContain(`<ItemID>${LISTING_ID}</ItemID>`);
    expect(revise).toContain('<StartPrice currencyID="USD">159.95</StartPrice>');
    expect(revise).toContain('<BestOfferAutoAcceptPrice currencyID="USD">143.95</BestOfferAutoAcceptPrice>');
    expect(revise).toContain('<MinimumBestOfferPrice currencyID="USD">119.99</MinimumBestOfferPrice>');
    expect(revise).not.toMatch(/<\/?Quantity\b/iu);
    expect(requests[1].body).not.toMatch(/<\/?StartPrice\b/iu);
  });

  it('only carries the thresholds the listing already has', async () => {
    const { adapter, requests } = world({
      ReviseInventoryStatus: [REJECTED_23004],
      GetItem: [getItemResponse({ autoAccept: '199.00' })],
      ReviseFixedPriceItem: [SUCCESS('ReviseFixedPriceItem')],
    });
    await adapter.reviseInventoryStatus({ listingId: LISTING_ID, field: 'price', price: usd('159.95') });
    expect(requests[2].body).toContain('<BestOfferAutoAcceptPrice currencyID="USD">159.19</BestOfferAutoAcceptPrice>');
    expect(requests[2].body).not.toContain('MinimumBestOfferPrice');
  });

  it('stays rejected (no write beyond the refused one) when no threshold can be read', async () => {
    const { adapter, requests } = world({
      ReviseInventoryStatus: [REJECTED_23004],
      GetItem: [getItemResponse({})],
    });
    await expect(adapter.reviseInventoryStatus({
      listingId: LISTING_ID, field: 'price', price: usd('159.95'),
    })).rejects.toMatchObject({ code: 'TRADING_ALIGN_REJECTED', providerErrorCodes: expect.arrayContaining(['23004']) });
    expect(requests.map((request) => request.call)).toEqual(['ReviseInventoryStatus', 'GetItem']);
  });

  it('never repairs other rejections or quantity revisions', async () => {
    const other = world({ ReviseInventoryStatus: [REJECTED_OTHER] });
    await expect(other.adapter.reviseInventoryStatus({
      listingId: LISTING_ID, field: 'price', price: usd('159.95'),
    })).rejects.toBeInstanceOf(TradingAlignDispatchError);
    expect(other.requests).toHaveLength(1);

    const quantity = world({ ReviseInventoryStatus: [REJECTED_23004] });
    await expect(quantity.adapter.reviseInventoryStatus({
      listingId: LISTING_ID, field: 'quantity', quantity: 2,
    })).rejects.toBeInstanceOf(TradingAlignDispatchError);
    expect(quantity.requests).toHaveLength(1);
  });
});

describe('planBestOfferThresholds', () => {
  it('keeps minimum < auto-accept < Buy It Now and refuses unsafe plans', () => {
    // A threshold that scales to the price itself is clamped one cent below.
    expect(planBestOfferThresholds({
      currentPrice: usd('100.00'), newPrice: usd('80.00'), autoAccept: usd('100.00'), minimum: usd('99.99'),
    })).toEqual({ autoAccept: '79.99', minimum: '79.98' });
    expect(planBestOfferThresholds({
      currentPrice: null, newPrice: usd('80.00'), autoAccept: usd('90.00'), minimum: null,
    })).toBeNull();
    expect(planBestOfferThresholds({
      currentPrice: usd('100.00'), newPrice: usd('80.00'), autoAccept: { value: '90.00', currency: 'CAD' }, minimum: null,
    })).toBeNull();
    expect(planBestOfferThresholds({
      currentPrice: usd('100.00'), newPrice: usd('0.01'), autoAccept: usd('90.00'), minimum: null,
    })).toBeNull();
  });

  it('refuses to serialize a threshold at or above the price', () => {
    expect(() => buildRevisePriceWithBestOfferXml({
      listingId: LISTING_ID, price: usd('159.95'), autoAccept: '159.95', minimum: null,
    })).toThrow(TradingAlignDispatchError);
    expect(() => buildRevisePriceWithBestOfferXml({
      listingId: LISTING_ID, price: usd('159.95'), autoAccept: null, minimum: null,
    })).toThrow(TradingAlignDispatchError);
  });
});
