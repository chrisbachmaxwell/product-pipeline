import { describe, expect, it } from 'vitest';
import { ShadowReadError } from '../errors.js';
import {
  MAX_ORDER_READ_WINDOW_MS,
  orderWindowQueryForTransport,
  validateBoundedOrderReadWindow,
} from '../order-window.js';

const NOW = '2026-08-11T18:00:00.000Z';

function expectDenied(window: unknown, now = NOW): void {
  try {
    validateBoundedOrderReadWindow(window, now);
    throw new Error('Expected order-window denial.');
  } catch (error) {
    expect(error).toBeInstanceOf(ShadowReadError);
    expect((error as ShadowReadError).code).toBe('order-window-denied');
  }
}

describe('bounded order observation window', () => {
  it('accepts an explicit maximum seven-day creationDate window', () => {
    const start = new Date(Date.parse(NOW) - MAX_ORDER_READ_WINDOW_MS).toISOString();
    const result = validateBoundedOrderReadWindow({
      creationDateStartUtc: start,
      creationDateEndUtc: NOW,
    }, NOW);
    expect(result).toEqual({
      kind: 'bounded-order-observation-window',
      eventTimeField: 'creationDate',
      lowerBoundInclusiveUtc: start,
      upperBoundExclusiveUtc: NOW,
      durationMs: MAX_ORDER_READ_WINDOW_MS,
      notCutoverWatermark: true,
      historicalBackfillAuthorized: false,
      fixtureBoundarySemantics: 'normalized-half-open',
      liveEbayBoundarySemanticsVerified: false,
    });
  });

  it('denies a missing lower or upper bound and unknown fields', () => {
    expectDenied({ creationDateEndUtc: NOW });
    expectDenied({ creationDateStartUtc: '2026-08-10T18:00:00.000Z' });
    expectDenied({
      creationDateStartUtc: '2026-08-10T18:00:00.000Z',
      creationDateEndUtc: NOW,
      cutoverWatermarkUtc: '2026-08-10T18:00:00.000Z',
    });
  });

  it('denies over-seven-day, reversed, empty, and future windows', () => {
    expectDenied({
      creationDateStartUtc: new Date(Date.parse(NOW) - MAX_ORDER_READ_WINDOW_MS - 1).toISOString(),
      creationDateEndUtc: NOW,
    });
    expectDenied({ creationDateStartUtc: NOW, creationDateEndUtc: NOW });
    expectDenied({
      creationDateStartUtc: NOW,
      creationDateEndUtc: '2026-08-11T18:00:00.001Z',
    });
  });

  it('requires canonical UTC timestamps', () => {
    expectDenied({
      creationDateStartUtc: '2026-08-10T12:00:00-06:00',
      creationDateEndUtc: NOW,
    });
    expectDenied({
      creationDateStartUtc: 'not-a-date',
      creationDateEndUtc: NOW,
    });
  });

  it('keeps the observation cursor/window distinct from a cutover watermark', () => {
    const window = validateBoundedOrderReadWindow({
      creationDateStartUtc: '2026-08-10T18:00:00.000Z',
      creationDateEndUtc: NOW,
    }, NOW);
    expect(window.notCutoverWatermark).toBe(true);
    expect(window.historicalBackfillAuthorized).toBe(false);
    expect(Object.keys(window)).not.toContain('cutoverWatermarkUtc');
  });

  it('renders normalized fixture queries without claiming live eBay boundary proof', () => {
    const window = validateBoundedOrderReadWindow({
      creationDateStartUtc: '2026-08-10T18:00:00.000Z',
      creationDateEndUtc: NOW,
    }, NOW);
    expect(orderWindowQueryForTransport(window, 'shopify')).toEqual({
      created_at_min: '2026-08-10T18:00:00.000Z',
      created_at_max: NOW,
    });
    expect(orderWindowQueryForTransport(window, 'ebay')).toEqual({
      filter: `creationdate:[2026-08-10T18:00:00.000Z..${NOW}]`,
    });
    expect(window.liveEbayBoundarySemanticsVerified).toBe(false);
  });

  it('rejects forged window objects at the transport helper seam', () => {
    expect(() => orderWindowQueryForTransport({
      kind: 'bounded-order-observation-window',
      eventTimeField: 'creationDate',
      lowerBoundInclusiveUtc: '2026-08-10T18:00:00.000Z',
      upperBoundExclusiveUtc: NOW,
      durationMs: 86_400_000,
      notCutoverWatermark: true,
      historicalBackfillAuthorized: false,
      fixtureBoundarySemantics: 'normalized-half-open',
      liveEbayBoundarySemanticsVerified: false,
    }, 'shopify')).toThrow(expect.objectContaining({ code: 'order-window-denied' }));
  });
});
