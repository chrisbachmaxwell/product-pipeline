/**
 * L105 (issue #208): listing 147531586972's PRICE_SYNC_REJECTED incident
 * quoted "eBay's own reason for the most recent rejection: " and then
 * nothing. The adapter read eBay's reason with a 600-char raw-text regex
 * that misses any real <Errors> block carrying ErrorParameters, persisted
 * the resulting empty string, and the watchdog quoted it verbatim. These
 * tests pin the parsed-reason extraction, the per-listing persistence, and
 * the watchdog's refusal to quote a blank or another listing's reason.
 * No network: the fetch is injected and the rejection file is a temp file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTradingAlignDispatchAdapter,
  describeTradingRejection,
} from '../trading-dispatch-adapter.js';
import { providerRejectionFor } from '../../server/incident-watchdog.js';

const LONG_MESSAGE = 'The Best Offer Auto Accept Price must be less than the Buy It Now price. '
  + 'Please lower the Auto Accept Price or raise the Buy It Now price before revising this item.';

/** A realistic Failure response whose <Errors> block is well over 600 chars. */
const FAILURE_BODY = '<?xml version="1.0" encoding="UTF-8"?>'
  + '<ReviseInventoryStatusResponse xmlns="urn:ebay:apis:eBLBaseComponents">'
  + '<Timestamp>2026-10-20T21:40:00.000Z</Timestamp><Ack>Failure</Ack>'
  + '<Errors><ShortMessage>Auto accept price invalid.</ShortMessage>'
  + `<LongMessage>${LONG_MESSAGE}</LongMessage>`
  + '<ErrorCode>21916264</ErrorCode><SeverityCode>Error</SeverityCode>'
  + '<ErrorParameters ParamID="0"><Value>147531586972</Value></ErrorParameters>'
  + '<ErrorParameters ParamID="1"><Value>1249.00</Value></ErrorParameters>'
  + '<ErrorParameters ParamID="2"><Value>1199.00</Value></ErrorParameters>'
  + `<ErrorParameters ParamID="3"><Value>${'x '.repeat(150)}</Value></ErrorParameters>`
  + '<ErrorClassification>RequestError</ErrorClassification></Errors>'
  + '<Errors><ShortMessage>Minor warning.</ShortMessage><LongMessage>Just a warning.</LongMessage>'
  + '<ErrorCode>21917091</ErrorCode><SeverityCode>Warning</SeverityCode></Errors>'
  + '<Version>1349</Version><Build>E1349</Build></ReviseInventoryStatusResponse>';

const tempDirectories: string[] = [];
afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('describeTradingRejection (L105)', () => {
  it('names the error code and long message from the parsed Errors entries', () => {
    const reason = describeTradingRejection({
      Ack: 'Failure',
      Errors: [
        { ShortMessage: 'Auto accept price invalid.', LongMessage: LONG_MESSAGE,
          ErrorCode: '21916264', SeverityCode: 'Error' },
        { ShortMessage: 'Minor warning.', ErrorCode: '21917091', SeverityCode: 'Warning' },
      ],
    }, FAILURE_BODY);
    expect(reason.startsWith('21916264: The Best Offer Auto Accept Price')).toBe(true);
    expect(reason).not.toContain('Minor warning');
    expect(reason.length).toBeLessThanOrEqual(300);
  });

  it('never returns an empty reason', () => {
    expect(describeTradingRejection({ Ack: 'Failure' }, '<Ack>Failure</Ack>'))
      .toBe("Ack=Failure with no <Errors> text in eBay's response");
    expect(describeTradingRejection({ Ack: 'Failure', Errors: { SeverityCode: 'Error' } },
      '<Errors><SeverityCode>Error</SeverityCode></Errors>')).toBe('Error');
  });

  it('redacts token-shaped runs', () => {
    const reason = describeTradingRejection({
      Errors: { LongMessage: 'Token v^1.1#i^1#AgAAAA0123456789abcdefghijKLMNOP is invalid',
        ErrorCode: '931', SeverityCode: 'Error' },
    }, '');
    expect(reason).not.toContain('AgAAAA0123456789abcdefghij');
  });
});

describe('Trading adapter persists the rejection for its listing (L105)', () => {
  it('records eBay\'s reason and the listing id for a long Errors block', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trading-rejection-'));
    tempDirectories.push(directory);
    const rejectionLogFile = path.join(directory, 'provider-rejections.json');
    const adapter = createTradingAlignDispatchAdapter({
      getAccessToken: async () => 'test-token',
      fetchImpl: (async () => new Response(FAILURE_BODY, { status: 200 })) as typeof fetch,
      rejectionLogFile,
    });
    const warn = console.warn;
    console.warn = () => {};
    try {
      await expect(adapter.reviseInventoryStatus({
        listingId: '147531586972',
        field: 'price',
        price: { value: '1199.00', currency: 'USD' },
      })).rejects.toMatchObject({ code: 'TRADING_ALIGN_REJECTED' });
    } finally {
      console.warn = warn;
    }
    const entries = JSON.parse(fs.readFileSync(rejectionLogFile, 'utf8')) as Array<{
      call: string; listingId?: string; reason: string;
    }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ call: 'ReviseInventoryStatus', listingId: '147531586972' });
    expect(entries[0].reason).toContain('21916264: The Best Offer Auto Accept Price');
    expect(providerRejectionFor('147531586972', entries)).toBe(entries[0].reason);
  });
});

describe('providerRejectionFor (L105)', () => {
  it('skips the blank reason issue #208 quoted', () => {
    expect(providerRejectionFor('147531586972', [
      { call: 'ReviseInventoryStatus', reason: '', atUtc: '2026-10-20T21:40:00.000Z' },
    ])).toBeNull();
  });

  it('never quotes another listing\'s rejection or an end/relist refusal', () => {
    const entries = [
      { call: 'ReviseInventoryStatus', listingId: '147531586972', reason: '21916264: own reason' },
      { call: 'ReviseInventoryStatus', listingId: '147520586676', reason: 'other listing' },
      { call: 'EndFixedPriceItem', reason: 'an end refusal' },
      { call: 'ReviseInventoryStatus', listingId: '147531586972', reason: '  ' },
    ];
    expect(providerRejectionFor('147531586972', entries)).toBe('21916264: own reason');
    expect(providerRejectionFor('999', entries)).toBeNull();
  });

  it('still uses a legacy price-revise entry recorded before listing ids existed', () => {
    expect(providerRejectionFor('147531586972', [
      { call: 'ReviseInventoryStatus', reason: 'legacy reason' },
    ])).toBe('legacy reason');
  });
});
