/**
 * L75 regression: eBay's Inventory API rejects any request missing the
 * Accept-Language header (error 25709). The withdrawOffer sell-out end —
 * the single most safety-critical write in the system — shipped without it
 * and was silently rejected 34 times over 38 hours while a sold lens stayed
 * buyable (11301-U684, 2026-09-24). These pins make both defects
 * structural: the header must be present, and a rejection must be LOUD.
 */
import { describe, expect, it, vi } from 'vitest';
import { createPriceInventoryDispatchAdapter } from '../dispatch-adapter.js';

function adapterWith(response: { status: number; text: string }) {
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const adapter = createPriceInventoryDispatchAdapter({
    getAccessToken: async () => 'token-a',
    fetchImpl: (async (url: string, init: RequestInit) => {
      requests.push({ url, headers: { ...(init.headers as Record<string, string>) } });
      return {
        status: response.status,
        headers: new Headers({ 'content-length': String(response.text.length) }),
        text: async () => response.text,
      } as unknown as Response;
    }) as typeof fetch,
  });
  return { adapter, requests };
}

describe('withdrawOffer provider contract (L75)', () => {
  it('sends BOTH eBay language headers on the withdraw call', async () => {
    const { adapter, requests } = adapterWith({ status: 200, text: '{"listingId":"1"}' });
    await adapter.withdrawOffer({ sku: 'CAN1-U1', offerId: '263746113011' });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toContain('/offer/263746113011/withdraw');
    expect(requests[0]!.headers['Accept-Language']).toBe('en-US');
    expect(requests[0]!.headers['Content-Language']).toBe('en-US');
  });

  it('logs a sanitized loud rejection before denying a non-200 withdraw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { adapter } = adapterWith({
        status: 400,
        text: '{"errors":[{"errorId":25709,"message":"Invalid value for header Accept-Language. token=aVeryLongSecretLookingRun1234567890"}]}',
      });
      await expect(adapter.withdrawOffer({ sku: 'CAN1-U1', offerId: '263746113011' }))
        .rejects.toMatchObject({ code: 'ALIGN_DISPATCH_REJECTED' });
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]![0]);
      expect(line).toContain('EBAY_ENDLIST_REJECTED');
      expect(line).toContain('25709');
      expect(line).not.toContain('aVeryLongSecretLookingRun1234567890');
    } finally {
      warn.mockRestore();
    }
  });
});
