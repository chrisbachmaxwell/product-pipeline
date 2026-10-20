/**
 * Incident #209 regression: eBay rejected three price revises for listing
 * 147521467887 and the PRICE_SYNC_REJECTED incident read "eBay's own reason
 * for the most recent rejection: " — empty. The adapter's L84/L87 reason
 * extractor was a `<Errors>[\s\S]{0,600}?</Errors>` window, so any error
 * block longer than 600 characters (a long LongMessage, ErrorParameters,
 * several errors) produced an empty string, which was persisted and quoted.
 * These pins make the reason structural: parsed from every error entry,
 * tagged with the listing id, and never empty.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTradingAlignDispatchAdapter,
  describeTradingRejection,
  TradingAlignDispatchError,
} from '../trading-dispatch-adapter.js';

const LISTING_ID = '147521467887';
const LONG_MESSAGE = 'The price you entered cannot be accepted for this listing because it '
  + 'conflicts with another setting on the item. '.repeat(8);

function failureBody(errors: string): string {
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<ReviseInventoryStatusResponse xmlns="urn:ebay:apis:eBLBaseComponents">'
    + '<Timestamp>2026-10-20T22:00:00.000Z</Timestamp><Ack>Failure</Ack>'
    + errors
    + '<Version>1349</Version><Build>E1349_CORE</Build>'
    + '</ReviseInventoryStatusResponse>';
}

function errorBlock(code: string, severity: string, short: string, long: string): string {
  return '<Errors>'
    + `<ShortMessage>${short}</ShortMessage><LongMessage>${long}</LongMessage>`
    + `<ErrorCode>${code}</ErrorCode><SeverityCode>${severity}</SeverityCode>`
    + '<ErrorParameters ParamID="0"><Value>1499.00</Value></ErrorParameters>'
    + '<ErrorClassification>RequestError</ErrorClassification>'
    + '</Errors>';
}

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function adapterReturning(text: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trading-rejection-'));
  tempDirs.push(dir);
  const ring = path.join(dir, 'provider-rejections.json');
  const adapter = createTradingAlignDispatchAdapter({
    getAccessToken: async () => 'test-iaf-token',
    providerRejectionsFile: ring,
    fetchImpl: (async () => new Response(text, {
      status: 200,
      headers: { 'Content-Type': 'text/xml' },
    })) as typeof fetch,
  });
  return { adapter, ring };
}

describe('Trading rejection reason (incident #209)', () => {
  it('persists eBay\'s reason for an error block longer than 600 characters', async () => {
    const block = errorBlock('21916635', 'Error', 'Invalid price.', LONG_MESSAGE);
    expect(block.length).toBeGreaterThan(600);
    const { adapter, ring } = adapterReturning(failureBody(block));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(adapter.reviseInventoryStatus({
      listingId: LISTING_ID,
      field: 'price',
      price: { value: '1499.00', currency: 'USD' },
    })).rejects.toMatchObject({ code: 'TRADING_ALIGN_REJECTED' });

    const entries = JSON.parse(fs.readFileSync(ring, 'utf8')) as Array<Record<string, string>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ call: 'ReviseInventoryStatus', listingId: LISTING_ID });
    expect(entries[0].reason).toMatch(/^\[21916635\] Invalid price\.: The price you entered/u);
    expect(entries[0].reason.length).toBeLessThanOrEqual(300);
    expect(warn.mock.calls.flat().join(' '))
      .toContain(`EBAY_TRADING_REJECTED call=ReviseInventoryStatus item=${LISTING_ID} [21916635]`);
  });

  it('reports every error and skips warnings when an error is present', () => {
    const text = failureBody(
      errorBlock('21917091', 'Warning', 'Requested StartPrice is the same.', 'Same price.')
      + errorBlock('21919188', 'Error', 'Price cannot be revised.', 'Price cannot be revised.')
      + errorBlock('291', 'Error', 'Auction ended.', 'You are not allowed to revise ended listings.'),
    );
    const reason = describeTradingRejection({
      text,
      callName: 'ReviseInventoryStatus',
      response: { Ack: 'Failure', Errors: [
        { ShortMessage: 'Requested StartPrice is the same.', LongMessage: 'Same price.', ErrorCode: '21917091', SeverityCode: 'Warning' },
        { ShortMessage: 'Price cannot be revised.', LongMessage: 'Price cannot be revised.', ErrorCode: '21919188', SeverityCode: 'Error' },
        { ShortMessage: 'Auction ended.', LongMessage: 'You are not allowed to revise ended listings.', ErrorCode: '291', SeverityCode: 'Error' },
      ] },
    });
    expect(reason).toBe('[21919188] Price cannot be revised. | '
      + '[291] Auction ended.: You are not allowed to revise ended listings.');
  });

  it('is never empty, even with no <Errors> in the response', async () => {
    const { adapter, ring } = adapterReturning(failureBody(''));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(adapter.endFixedPriceItem({ listingId: LISTING_ID }))
      .rejects.toBeInstanceOf(TradingAlignDispatchError);
    const entries = JSON.parse(fs.readFileSync(ring, 'utf8')) as Array<Record<string, string>>;
    // Root name mismatch for the End call: still a non-empty, honest reason.
    expect(entries[0].reason).toBe("eBay's reply was not a EndFixedPriceItemResponse");
    expect(describeTradingRejection({
      text: failureBody(''),
      callName: 'ReviseInventoryStatus',
      response: { Ack: 'Failure' },
    })).toBe('eBay returned Ack=Failure with no <Errors> detail');
  });
});
