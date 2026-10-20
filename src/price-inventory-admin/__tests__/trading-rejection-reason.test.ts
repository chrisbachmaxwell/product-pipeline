/**
 * Incident #206 (L105): eBay rejected three price revises for listing
 * 147487396129 and the incident quoted "eBay's own reason for the most
 * recent rejection: " followed by NOTHING. The adapter's 600-character
 * `<Errors>` window matched nothing once eBay's first Errors block ran
 * longer, so an empty reason was persisted, and the watchdog quoted the
 * global last entry rather than this listing's. Only the HTTP transport is
 * faked; no network access occurs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTradingAlignDispatchAdapter,
  describeTradingRejection,
  TradingAlignDispatchError,
} from '../trading-dispatch-adapter.js';
import { evaluateIncidentCandidates, type ProviderRejection } from '../../server/incident-watchdog.js';

const LISTING_ID = '147487396129';
const LONG_MESSAGE = 'The price you entered cannot be accepted for this listing because it '
  + 'conflicts with the Best Offer settings currently on the item. The auto-accept and '
  + 'auto-decline prices must both be lower than the Buy It Now price. Revise the Best Offer '
  + 'settings on the listing, or choose a different price, and then try again. '
  + 'Additional information about pricing rules is available in Seller Center.';
const FAILURE_XML = '<?xml version="1.0" encoding="UTF-8"?>'
  + '<ReviseInventoryStatusResponse xmlns="urn:ebay:apis:eBLBaseComponents">'
  + '<Timestamp>2026-10-20T21:00:00.000Z</Timestamp><Ack>Failure</Ack>'
  + '<Errors><ShortMessage>Invalid Best Offer price.</ShortMessage>'
  + `<LongMessage>${LONG_MESSAGE}</LongMessage><ErrorCode>21919188</ErrorCode>`
  + '<SeverityCode>Error</SeverityCode>'
  + '<ErrorParameters ParamID="0"><Value>149.00</Value></ErrorParameters>'
  + '<ErrorParameters ParamID="1"><Value>139.00</Value></ErrorParameters>'
  + '<ErrorClassification>RequestError</ErrorClassification></Errors>'
  + '<Version>1349</Version><Build>E1349_CORE_API_1</Build>'
  + '</ReviseInventoryStatusResponse>';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function rejectionsFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-rejections-'));
  directories.push(directory);
  return path.join(directory, 'provider-rejections.json');
}

function adapterAnswering(file: string, body: string, status = 200) {
  return createTradingAlignDispatchAdapter({
    rejectionsFile: file,
    getAccessToken: async () => 'fixture-token',
    fetchImpl: (async () => new Response(body, { status })) as typeof fetch,
  });
}

async function revisePrice(adapter: ReturnType<typeof adapterAnswering>): Promise<string | null> {
  try {
    await adapter.reviseInventoryStatus({
      listingId: LISTING_ID, field: 'price', price: { value: '139.00', currency: 'USD' },
    });
    return null;
  } catch (error) {
    return error instanceof TradingAlignDispatchError ? error.code : 'unexpected';
  }
}

describe('Trading price rejection reason (incident #206)', () => {
  it('the fixture Errors block is longer than the old 600-character window', () => {
    expect(/<Errors>[\s\S]*?<\/Errors>/u.exec(FAILURE_XML)![0].length).toBeGreaterThan(600);
  });

  it('persists eBay\'s code and message for the exact listing, never an empty reason', async () => {
    const file = rejectionsFile();
    const adapter = adapterAnswering(file, FAILURE_XML);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await revisePrice(adapter)).toBe('TRADING_ALIGN_REJECTED');
    }
    const entries = JSON.parse(fs.readFileSync(file, 'utf8')) as Array<Record<string, string>>;
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(entry).toMatchObject({ call: 'ReviseInventoryStatus', listingId: LISTING_ID });
      expect(entry.reason).toMatch(/^21919188: Invalid Best Offer price\. — The price you entered/);
      expect(entry.reason.length).toBeLessThanOrEqual(300);
      expect(entry.reason).not.toContain('fixture-token');
    }
  });

  it('records a non-200 answer for the listing instead of leaving no trace', async () => {
    const file = rejectionsFile();
    expect(await revisePrice(adapterAnswering(file, 'Service Unavailable', 503)))
      .toBe('TRADING_ALIGN_WRITE_FAILED');
    const entries = JSON.parse(fs.readFileSync(file, 'utf8')) as Array<Record<string, string>>;
    expect(entries).toEqual([expect.objectContaining({
      listingId: LISTING_ID, reason: expect.stringContaining('HTTP 503'),
    })]);
  });

  it('describes a Failure with no Errors element instead of returning ""', () => {
    expect(describeTradingRejection({ Ack: 'Failure' }, 'Failure'))
      .toBe('Ack=Failure with no readable Errors element');
    expect(describeTradingRejection({
      Errors: [{ ErrorCode: '1', ShortMessage: 'A' }, { ErrorCode: '2', ShortMessage: 'B', LongMessage: 'B' }],
    }, 'Failure')).toBe('1: A | 2: B');
  });

  it('the incident for three rejections carries this listing\'s reason end to end', async () => {
    const file = rejectionsFile();
    // Another listing's rejection lands AFTER ours, and a legacy entry has
    // no listing id: neither may be quoted for 147487396129.
    expect(await revisePrice(adapterAnswering(file, FAILURE_XML))).toBe('TRADING_ALIGN_REJECTED');
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8')) as ProviderRejection[];
    const providerRejections: ProviderRejection[] = [
      { call: 'ReviseInventoryStatus', reason: '', atUtc: '2026-10-20T20:00:00.000Z' },
      ...persisted,
      { call: 'EndFixedPriceItem', listingId: '147000000001', reason: 'other listing', atUtc: '2026-10-20T22:00:00.000Z' },
    ];
    const [incident] = evaluateIncidentCandidates({
      snapshot: {
        observedAtUtc: new Date().toISOString(),
        rows: [{
          shopify: { sku: 'LENS-206', title: 'Lens', available: 2, productStatus: 'ACTIVE' },
          ebay: { listingId: LISTING_ID },
        }],
      },
      signals: {
        oldestUnresolvedOrder: null, unresolvedCreates: [], unresolvedFulfillments: [],
        repeatedEndFailures: [],
        repeatedPriceFailures: [{ sku: `listing ${LISTING_ID}`, count: 3, lastAtUtc: new Date().toISOString() }],
      },
      nowMs: Date.now(),
      providerRejections,
    });
    expect(incident).toMatchObject({ code: 'PRICE_SYNC_REJECTED', severity: 'critical' });
    expect(incident!.detail).toContain(
      "eBay's own reason for the most recent rejection: ReviseInventoryStatus: 21919188: Invalid Best Offer price.");
    expect(incident!.detail).not.toContain('other listing');
  });
});
