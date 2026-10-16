/**
 * L103 regression (incident #190): a Trading price cut to or below the
 * listing's Best Offer Auto-Accept price was refused by eBay (23004) on
 * every sweep, forever, because ReviseInventoryStatus cannot change Best
 * Offer. The adapter now recovers with exactly one ReviseFixedPriceItem
 * that carries the same StartPrice and deletes only the thresholds eBay
 * named. Network-free: the transport is a captured fake.
 */
import { describe, expect, it } from 'vitest';
import {
  bestOfferThresholdConflicts,
  buildPriceWithBestOfferThresholdsClearedXml,
  createTradingAlignDispatchAdapter,
  TradingAlignDispatchError,
} from '../trading-dispatch-adapter.js';

const LISTING_ID = '147436215816';

/** eBay's real refusal shape from incident #190 (SKU/ids are listing data). */
const AUTO_ACCEPT_REFUSAL = '<?xml version="1.0" encoding="UTF-8"?>'
  + '<ReviseInventoryStatusResponse xmlns="urn:ebay:apis:eBLBaseComponents">'
  + '<Ack>Failure</Ack><Errors>'
  + '<ShortMessage>Invalid AutoAccept price.</ShortMessage>'
  + '<LongMessage>The Best Offer Auto Accept Price must be less than the Buy It Now price.</LongMessage>'
  + '<ErrorCode>23004</ErrorCode><SeverityCode>Error</SeverityCode>'
  + '<ErrorParameters ParamID="0"><Value>159.95 USD</Value></ErrorParameters>'
  + `<ErrorParameters ParamID="1"><Value>${LISTING_ID}</Value></ErrorParameters>`
  + '<ErrorParameters ParamID="2"><Value>AFF050S-700-U029</Value></ErrorParameters>'
  + '<ErrorClassification>RequestError</ErrorClassification>'
  + '</Errors></ReviseInventoryStatusResponse>';

const MINIMUM_REFUSAL = '<ReviseInventoryStatusResponse xmlns="urn:ebay:apis:eBLBaseComponents">'
  + '<Ack>Failure</Ack><Errors>'
  + '<LongMessage>The Minimum Best Offer price must be less than the Buy It Now price.</LongMessage>'
  + '<ErrorCode>23005</ErrorCode><SeverityCode>Error</SeverityCode>'
  + '</Errors></ReviseInventoryStatusResponse>';

const OTHER_REFUSAL = '<ReviseInventoryStatusResponse xmlns="urn:ebay:apis:eBLBaseComponents">'
  + '<Ack>Failure</Ack><Errors>'
  + '<LongMessage>Item cannot be accessed.</LongMessage>'
  + '<ErrorCode>17</ErrorCode><SeverityCode>Error</SeverityCode>'
  + '</Errors></ReviseInventoryStatusResponse>';

const success = (callName: string): string =>
  `<${callName}Response xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack></${callName}Response>`;

function world(responses: Record<string, string[]>) {
  const requests: Array<{ callName: string; body: string }> = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const callName = (init?.headers as Record<string, string>)['X-EBAY-API-CALL-NAME']!;
    requests.push({ callName, body: String(init?.body ?? '') });
    const body = responses[callName]?.shift() ?? success(callName);
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/xml' } });
  };
  const adapter = createTradingAlignDispatchAdapter({
    fetchImpl,
    getAccessToken: async () => 'test-iaf-token',
  });
  return { adapter, requests };
}

describe('Trading price revise refused by a Best Offer threshold (L103, #190)', () => {
  it('lands the same price with the Auto-Accept threshold removed, in one recovery call', async () => {
    const { adapter, requests } = world({ ReviseInventoryStatus: [AUTO_ACCEPT_REFUSAL] });
    await adapter.reviseInventoryStatus({
      listingId: LISTING_ID, field: 'price', price: { value: '159.95', currency: 'USD' },
    });
    expect(requests.map((request) => request.callName))
      .toEqual(['ReviseInventoryStatus', 'ReviseFixedPriceItem']);
    const recovery = requests[1]!.body;
    expect(recovery).toContain(
      '<DeletedField>Item.ListingDetails.BestOfferAutoAcceptPrice</DeletedField>'
      + `<Item><ItemID>${LISTING_ID}</ItemID>`
      + '<StartPrice currencyID="USD">159.95</StartPrice></Item>',
    );
    // Only what eBay named: the auto-decline floor is untouched, and the
    // recovery can never carry a quantity.
    expect(recovery).not.toContain('MinimumBestOfferPrice');
    expect(recovery).not.toMatch(/<\/?Quantity\b/iu);
    expect((recovery.match(/<DeletedField>/g) ?? []).length).toBe(1);
  });

  it('clears the auto-decline floor only when eBay names it', async () => {
    const { adapter, requests } = world({ ReviseInventoryStatus: [MINIMUM_REFUSAL] });
    await adapter.reviseInventoryStatus({
      listingId: LISTING_ID, field: 'price', price: { value: '99.00', currency: 'USD' },
    });
    expect(requests[1]!.body)
      .toContain('<DeletedField>Item.ListingDetails.MinimumBestOfferPrice</DeletedField><Item>');
    expect(requests[1]!.body).not.toContain('BestOfferAutoAcceptPrice');
  });

  it('stays an ordinary rejection for any other refusal — no second call', async () => {
    const { adapter, requests } = world({ ReviseInventoryStatus: [OTHER_REFUSAL] });
    await expect(adapter.reviseInventoryStatus({
      listingId: LISTING_ID, field: 'price', price: { value: '159.95', currency: 'USD' },
    })).rejects.toMatchObject({ code: 'TRADING_ALIGN_REJECTED' });
    expect(requests).toHaveLength(1);
  });

  it('never recovers a quantity revise through a price call', async () => {
    const { adapter, requests } = world({ ReviseInventoryStatus: [AUTO_ACCEPT_REFUSAL] });
    await expect(adapter.reviseInventoryStatus({
      listingId: LISTING_ID, field: 'quantity', quantity: 2,
    })).rejects.toBeInstanceOf(TradingAlignDispatchError);
    expect(requests).toHaveLength(1);
  });

  it('reports a refused recovery as rejected, with no third call', async () => {
    const { adapter, requests } = world({
      ReviseInventoryStatus: [AUTO_ACCEPT_REFUSAL],
      ReviseFixedPriceItem: [OTHER_REFUSAL.replace(/ReviseInventoryStatus/g, 'ReviseFixedPriceItem')],
    });
    await expect(adapter.reviseInventoryStatus({
      listingId: LISTING_ID, field: 'price', price: { value: '159.95', currency: 'USD' },
    })).rejects.toMatchObject({ code: 'TRADING_ALIGN_REJECTED' });
    expect(requests).toHaveLength(2);
  });

  it('reads thresholds only from error blocks, ignoring warnings', () => {
    expect(bestOfferThresholdConflicts(AUTO_ACCEPT_REFUSAL)).toEqual(['autoAccept']);
    expect(bestOfferThresholdConflicts(MINIMUM_REFUSAL)).toEqual(['minimum']);
    expect(bestOfferThresholdConflicts(OTHER_REFUSAL)).toEqual([]);
    expect(bestOfferThresholdConflicts(
      AUTO_ACCEPT_REFUSAL.replace('<SeverityCode>Error</SeverityCode>', '<SeverityCode>Warning</SeverityCode>'),
    )).toEqual([]);
  });

  it('refuses an unsafe recovery payload', () => {
    const price = { value: '159.95', currency: 'USD' };
    expect(() => buildPriceWithBestOfferThresholdsClearedXml({ listingId: 'x', price, clear: ['autoAccept'] }))
      .toThrow(TradingAlignDispatchError);
    expect(() => buildPriceWithBestOfferThresholdsClearedXml({ listingId: LISTING_ID, price, clear: [] }))
      .toThrow(TradingAlignDispatchError);
    expect(() => buildPriceWithBestOfferThresholdsClearedXml({
      listingId: LISTING_ID, price: { value: '0', currency: 'USD' }, clear: ['autoAccept'],
    })).toThrow(TradingAlignDispatchError);
  });
});
