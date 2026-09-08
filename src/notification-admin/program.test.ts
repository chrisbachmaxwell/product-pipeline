import { describe, expect, it } from 'vitest';
import { deriveScopeKey } from '../migration-store/index.js';
import { LISTING_DRAFT_SCOPE } from '../listing-control-config.js';
import { buildNotificationAdminProgram, SUBSCRIBED_EVENTS } from './program.js';

const SCOPE_KEY = deriveScopeKey({
  shopifyStoreDomain: LISTING_DRAFT_SCOPE.shopifyStoreDomain,
  ebayEnvironment: LISTING_DRAFT_SCOPE.ebayEnvironment,
  ebaySellerId: LISTING_DRAFT_SCOPE.ebaySellerId,
  ebayMarketplaceId: LISTING_DRAFT_SCOPE.ebayMarketplaceId,
});
const RECEIVER_URL = 'https://ebay-sync-app-production.up.railway.app/webhooks/ebay/notifications';

function world(responseAck = 'Success') {
  const requests: Array<{ callName: string; body: string }> = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  const program = buildNotificationAdminProgram({
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      requests.push({
        callName: (init?.headers as Record<string, string>)['X-EBAY-API-CALL-NAME']!,
        body: String(init?.body ?? ''),
      });
      return new Response(
        `<?xml version="1.0"?><SetNotificationPreferencesResponse><Ack>${responseAck}</Ack></SetNotificationPreferencesResponse>`,
        { status: 200 },
      );
    }) as typeof fetch,
    getAccessToken: async () => 'test-token',
    io: {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      setExitCode: (code) => exitCodes.push(code),
    },
  });
  const run = (argv: string[]) => program.parseAsync(argv, { from: 'user' });
  return { requests, stdout, stderr, exitCodes, run };
}

describe('notification-admin ceremony', () => {
  it('subscribes with one bounded provider call carrying exactly the alignment events', async () => {
    const w = world();
    await w.run(['subscribe',
      '--confirm-scope', SCOPE_KEY,
      '--notification-url', RECEIVER_URL,
      '--confirm-subscribe',
    ]);
    expect(w.exitCodes).toHaveLength(0);
    expect(w.requests).toHaveLength(1);
    expect(w.requests[0]!.callName).toBe('SetNotificationPreferences');
    expect(w.requests[0]!.body).toContain(`<ApplicationURL>${RECEIVER_URL}</ApplicationURL>`);
    for (const event of SUBSCRIBED_EVENTS) {
      expect(w.requests[0]!.body).toContain(`<EventType>${event}</EventType>`);
    }
    expect(JSON.parse(w.stdout.at(-1)!)).toMatchObject({ status: 'subscribed' });
  });

  it('denies a wrong scope key before any provider call', async () => {
    const w = world();
    await w.run(['subscribe',
      '--confirm-scope', 'sha256:'.padEnd(71, 'a'),
      '--notification-url', RECEIVER_URL,
      '--confirm-subscribe',
    ]);
    expect(w.requests).toHaveLength(0);
    expect(JSON.parse(w.stderr.at(-1)!)).toMatchObject({
      code: 'NOTIFICATION_SCOPE_CONFIRMATION_MISMATCH',
    });
  });

  it('denies a URL that is not the exact https receiver path', async () => {
    const w = world();
    for (const url of [
      'http://ebay-sync-app-production.up.railway.app/webhooks/ebay/notifications',
      'https://evil.example.com/steal',
      'https://ebay-sync-app-production.up.railway.app/webhooks/ebay/notifications?x=1',
    ]) {
      await w.run(['subscribe',
        '--confirm-scope', SCOPE_KEY, '--notification-url', url, '--confirm-subscribe',
      ]);
    }
    expect(w.requests).toHaveLength(0);
    expect(JSON.parse(w.stderr.at(-1)!)).toMatchObject({ code: 'NOTIFICATION_URL_INVALID' });
  });

  it('surfaces an eBay rejection as a denial with exit code 1', async () => {
    const w = world('Failure');
    await w.run(['subscribe',
      '--confirm-scope', SCOPE_KEY,
      '--notification-url', RECEIVER_URL,
      '--confirm-subscribe',
    ]);
    expect(w.exitCodes.at(-1)).toBe(1);
    expect(JSON.parse(w.stderr.at(-1)!)).toMatchObject({ code: 'NOTIFICATION_CALL_REJECTED' });
  });
});
