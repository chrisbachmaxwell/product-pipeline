import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_NOTIFICATION_BYTES,
  verifyEbayNotification,
} from './ebay-notification-receiver.js';

const CREDS = Object.freeze({ devId: 'dev-1', appId: 'app-1', certId: 'cert-1' });
const NOW = Date.parse('2026-09-08T20:00:00.000Z');

function signature(timestamp: string): string {
  return createHash('md5')
    .update(timestamp + CREDS.devId + CREDS.appId + CREDS.certId, 'utf8')
    .digest('base64');
}

function notification(overrides: {
  timestamp?: string;
  signature?: string;
  event?: string;
  itemId?: string;
} = {}): string {
  const timestamp = overrides.timestamp ?? '2026-09-08T19:59:30.000Z';
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">'
    + '<soapenv:Header><ebl:RequesterCredentials xmlns:ebl="urn:ebay:apis:eBLBaseComponents">'
    + `<ebl:NotificationSignature>${overrides.signature ?? signature(timestamp)}</ebl:NotificationSignature>`
    + '</ebl:RequesterCredentials></soapenv:Header>'
    + '<soapenv:Body><GetItemTransactionsResponse xmlns="urn:ebay:apis:eBLBaseComponents">'
    + `<Timestamp>${timestamp}</Timestamp>`
    + `<NotificationEventName>${overrides.event ?? 'FixedPriceTransaction'}</NotificationEventName>`
    + `<Item><ItemID>${overrides.itemId ?? '147232036779'}</ItemID></Item>`
    + '</GetItemTransactionsResponse></soapenv:Body></soapenv:Envelope>';
}

describe('eBay platform notification verification', () => {
  it('verifies a signed sale notification and marks it alignment-relevant', () => {
    const verdict = verifyEbayNotification({
      body: notification(), credentials: CREDS, nowMs: NOW,
    });
    expect(verdict).toMatchObject({
      outcome: 'verified',
      eventName: 'FixedPriceTransaction',
      itemId: '147232036779',
      alignmentRelevant: true,
    });
  });

  it('verifies but does not align an event that cannot change availability', () => {
    const verdict = verifyEbayNotification({
      body: notification({ event: 'MyMessagesM2MMessage' }), credentials: CREDS, nowMs: NOW,
    });
    expect(verdict).toMatchObject({ outcome: 'verified', alignmentRelevant: false });
  });

  it('rejects a wrong signature without leaking why beyond a fixed code', () => {
    const verdict = verifyEbayNotification({
      body: notification({ signature: signature('2026-09-08T00:00:00.000Z') }),
      credentials: CREDS,
      nowMs: NOW,
    });
    expect(verdict).toMatchObject({ outcome: 'rejected', reason: 'signature_mismatch' });
  });

  it('rejects a stale timestamp even with a valid signature, blocking replays', () => {
    const old = '2026-09-08T18:00:00.000Z';
    const verdict = verifyEbayNotification({
      body: notification({ timestamp: old, signature: signature(old) }),
      credentials: CREDS,
      nowMs: NOW,
    });
    expect(verdict).toMatchObject({ outcome: 'rejected', reason: 'timestamp_stale' });
  });

  it('rejects when credentials are unavailable rather than skipping verification', () => {
    const verdict = verifyEbayNotification({
      body: notification(), credentials: null, nowMs: NOW,
    });
    expect(verdict).toMatchObject({ outcome: 'rejected', reason: 'credentials_unavailable' });
  });

  it('drops malformed and oversized bodies unread', () => {
    expect(verifyEbayNotification({ body: 42, credentials: CREDS, nowMs: NOW }).reason)
      .toBe('body_invalid');
    expect(verifyEbayNotification({ body: '', credentials: CREDS, nowMs: NOW }).reason)
      .toBe('body_invalid');
    expect(verifyEbayNotification({
      body: 'x'.repeat(MAX_NOTIFICATION_BYTES + 1), credentials: CREDS, nowMs: NOW,
    }).reason).toBe('body_invalid');
    expect(verifyEbayNotification({
      body: '<Envelope>no timestamp</Envelope>', credentials: CREDS, nowMs: NOW,
    }).reason).toBe('timestamp_missing');
  });
});
