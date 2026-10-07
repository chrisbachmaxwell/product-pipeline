import { describe, expect, it } from 'vitest';
import { hasEbayHoldTag } from './ebay-hold-tag.js';

describe('no-ebay hold tag', () => {
  it('matches the tag case- and space-insensitively and nothing else', () => {
    expect(hasEbayHoldTag(['lens', 'no-ebay'])).toBe(true);
    expect(hasEbayHoldTag([' No-eBay '])).toBe(true);
    expect(hasEbayHoldTag(['ebay', 'no-ebay-later', 'noebay'])).toBe(false);
    expect(hasEbayHoldTag(undefined)).toBe(false);
  });
});
