/**
 * L105 (#201): eBay refused every Shopify price change for a Trading
 * listing because the new Buy It Now price was not above the listing's Best
 * Offer auto-accept price (error 23004). ReviseInventoryStatus cannot change
 * Best Offer settings, so the sweep retried the same refused request
 * forever. The adapter now clears exactly the conflicting threshold in one
 * ReviseFixedPriceItem carrying the same StartPrice. Only the HTTP transport
 * is faked; no network access of any kind occurs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bestOfferConflict,
  buildRevisePriceClearingBestOfferXml,
  createTradingAlignDispatchAdapter,
  TradingAlignDispatchError,
} from '../trading-dispatch-adapter.js';

const LISTING_ID = '147429532345';
const PRICE = { value: '149.95', currency: 'USD' } as const;

const AUTO_ACCEPT_ERROR = '<Errors><ShortMessage>Invalid AutoAccept price.</ShortMessage>'
  + '<LongMessage>The Best Offer Auto Accept Price must be less than the Buy It Now price.</LongMessage>'
  + '<ErrorCode>23004</ErrorCode><SeverityCode>Error</SeverityCode>'
  + '<ErrorParameters ParamID="0"><Value>159.95 USD</Value></ErrorParameters>'
  + '<ErrorClassification>RequestError</ErrorClassification></Errors>';
const MINIMUM_ERROR = '<Errors><ShortMessage>Invalid Minimum Best Offer price.</ShortMessage>'
  + '<LongMessage>The Best Offer Auto Decline Price must be less than the Buy It Now price.</LongMessage>'
  + '<ErrorCode>23003</ErrorCode><SeverityCode>Error</SeverityCode></Errors>';
const OTHER_ERROR = '<Errors><ShortMessage>Item cannot be accessed.</ShortMessage>'
  + '<ErrorCode>17</ErrorCode><SeverityCode>Error</SeverityCode></Errors>';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function harness(responses: ReadonlyArray<{ ack: 'Success' | 'Failure'; errors?: string }>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-best-offer-'));
  roots.push(root);
  const rejectionLogPath = path.join(root, 'provider-rejections.json');
  const requests: Array<{ callName: string; body: string }> = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const callName = String((init?.headers as Record<string, string>)['X-EBAY-API-CALL-NAME']);
    requests.push({ callName, body: String(init?.body ?? '') });
    const next = responses[requests.length - 1] ?? { ack: 'Failure', errors: OTHER_ERROR };
    return new Response(
      '<?xml version="1.0" encoding="UTF-8"?>'
      + `<${callName}Response xmlns="urn:ebay:apis:eBLBaseComponents">`
      + `<Ack>${next.ack}</Ack>${next.errors ?? ''}`
      + `</${callName}Response>`,
      { status: 200, headers: { 'Content-Type': 'text/xml' } },
    );
  }) as typeof fetch;
  const adapter = createTradingAlignDispatchAdapter({
    fetchImpl,
    getAccessToken: async () => 'test-iaf-token',
    rejectionLogPath,
  });
  const ring = (): Array<{ call: string; listingId?: string; reason: string }> =>
    fs.existsSync(rejectionLogPath) ? JSON.parse(fs.readFileSync(rejectionLogPath, 'utf8')) : [];
  return { adapter, requests, ring };
}

describe('Best Offer threshold conflict on a price alignment (L105, #201)', () => {
  it('clears the auto-accept price and lands the same StartPrice when eBay refuses with 23004', async () => {
    const world = harness([
      { ack: 'Failure', errors: AUTO_ACCEPT_ERROR },
      { ack: 'Success' },
    ]);
    await world.adapter.reviseInventoryStatus({ listingId: LISTING_ID, field: 'price', price: PRICE });

    expect(world.requests.map((request) => request.callName))
      .toEqual(['ReviseInventoryStatus', 'ReviseFixedPriceItem']);
    const fallback = world.requests[1]!.body;
    expect(fallback).toContain('<DeletedField>Item.ListingDetails.BestOfferAutoAcceptPrice</DeletedField>');
    expect(fallback).not.toContain('MinimumBestOfferPrice');
    expect(fallback).toContain(`<ItemID>${LISTING_ID}</ItemID>`);
    expect(fallback).toContain('<StartPrice currencyID="USD">149.95</StartPrice>');
    expect(fallback).not.toMatch(/<\/?Quantity\b/iu);
    // A resolved conflict is not a rejection: nothing for the watchdog.
    expect(world.ring()).toEqual([]);
  });

  it('clears the minimum too when it is the remaining blocker, at most two fallbacks', async () => {
    const world = harness([
      { ack: 'Failure', errors: AUTO_ACCEPT_ERROR },
      { ack: 'Failure', errors: MINIMUM_ERROR },
      { ack: 'Success' },
    ]);
    await world.adapter.reviseInventoryStatus({ listingId: LISTING_ID, field: 'price', price: PRICE });
    expect(world.requests).toHaveLength(3);
    expect(world.requests[2]!.body).toContain('Item.ListingDetails.BestOfferAutoAcceptPrice');
    expect(world.requests[2]!.body).toContain('Item.ListingDetails.MinimumBestOfferPrice');
  });

  it('stops after the fallback when eBay refuses for a non-Best-Offer reason, keyed to the listing', async () => {
    const world = harness([
      { ack: 'Failure', errors: AUTO_ACCEPT_ERROR },
      { ack: 'Failure', errors: OTHER_ERROR },
    ]);
    await expect(world.adapter.reviseInventoryStatus({
      listingId: LISTING_ID, field: 'price', price: PRICE,
    })).rejects.toMatchObject({ code: 'TRADING_ALIGN_REJECTED' });
    expect(world.requests).toHaveLength(2);
    expect(world.ring()).toEqual([expect.objectContaining({
      call: 'ReviseFixedPriceItem', listingId: LISTING_ID,
    })]);
  });

  it('never falls back for an unrelated price rejection or for a quantity alignment', async () => {
    const price = harness([{ ack: 'Failure', errors: OTHER_ERROR }]);
    await expect(price.adapter.reviseInventoryStatus({
      listingId: LISTING_ID, field: 'price', price: PRICE,
    })).rejects.toBeInstanceOf(TradingAlignDispatchError);
    expect(price.requests).toHaveLength(1);
    expect(price.ring()).toEqual([expect.objectContaining({ listingId: LISTING_ID })]);

    const quantity = harness([{ ack: 'Failure', errors: AUTO_ACCEPT_ERROR }]);
    await expect(quantity.adapter.reviseInventoryStatus({
      listingId: LISTING_ID, field: 'quantity', quantity: 2,
    })).rejects.toBeInstanceOf(TradingAlignDispatchError);
    expect(quantity.requests).toHaveLength(1);
  });

  it('classifies only Best Offer threshold errors and serializes a bounded request', () => {
    expect(bestOfferConflict(AUTO_ACCEPT_ERROR)).toEqual({ autoAccept: true, minimum: false });
    expect(bestOfferConflict(MINIMUM_ERROR)).toEqual({ autoAccept: false, minimum: true });
    expect(bestOfferConflict(OTHER_ERROR)).toBeNull();
    expect(() => buildRevisePriceClearingBestOfferXml({
      listingId: LISTING_ID, price: PRICE, clearAutoAccept: false, clearMinimum: false,
    })).toThrow(TradingAlignDispatchError);
    expect(() => buildRevisePriceClearingBestOfferXml({
      listingId: 'x', price: PRICE, clearAutoAccept: true, clearMinimum: false,
    })).toThrow(TradingAlignDispatchError);
  });
});
