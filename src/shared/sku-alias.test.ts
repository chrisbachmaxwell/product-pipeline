import { describe, expect, it } from 'vitest';
import {
  decodeEbaySkuAlias,
  ebayInventorySkuFor,
  ebaySkuMatchesShopifySku,
  isEbayTargetSku,
} from './sku-alias.js';

describe('eBay SKU alias codec (L116, incident #239)', () => {
  it('keeps every SKU eBay accepts as-is byte-for-byte', () => {
    for (const sku of ['CAN3570-U119', 'APD0170A3B-OB', '16938039-U024', 'a.b-c']) {
      expect(ebayInventorySkuFor(sku)).toBe(sku);
      expect(decodeEbaySkuAlias(sku)).toBeNull();
    }
  });

  it('aliases the incident SKU and the earlier L116 SKUs, and decodes them back exactly', () => {
    expect(ebayInventorySkuFor('ILCE6400/B-U641')).toBe('PP1_ILCE6400_2FB-U641');
    expect(ebayInventorySkuFor('ILCE-7M4/B-U213')).toBe('PP1_ILCE-7M4_2FB-U213');
    expect(ebayInventorySkuFor('ILCE7C/B-U672')).toBe('PP1_ILCE7C_2FB-U672');
    expect(ebayInventorySkuFor('EF 50 1.8')).toBe('PP1_EF_2050_201.8');
    for (const sku of ['ILCE6400/B-U641', 'ILCE-7M4/B-U213', 'EF 50 1.8', 'A/B C.D-E']) {
      const alias = ebayInventorySkuFor(sku) as string;
      expect(isEbayTargetSku(alias)).toBe(true);
      expect(decodeEbaySkuAlias(alias)).toBe(sku);
      expect(ebaySkuMatchesShopifySku(alias, sku)).toBe(true);
    }
  });

  it('decodes only the exact canonical form', () => {
    for (const value of [
      'PP1_ILCE6400_2fB-U641', // lower-case hex
      'PP1_ABC', // decodes to a direct SKU
      'PP1_A_5FB', // escaped `_`, which no aliasable SKU contains
      'PP1_A_2', // truncated escape
      'PP1_', // empty body
      'ILCE6400/B-U641',
    ]) {
      expect(decodeEbaySkuAlias(value)).toBeNull();
      expect(isEbayTargetSku(value)).toBe(false);
    }
    // Another prefix is an ordinary direct SKU, never decoded.
    expect(decodeEbaySkuAlias('PP2_A_2FB')).toBeNull();
    expect(isEbayTargetSku('PP2_A_2FB')).toBe(true);
  });

  it('escapes `_` so an aliased SKU holding one still decodes exactly', () => {
    expect(ebayInventorySkuFor('A_/B')).toBe('PP1_A_5F_2FB');
    expect(decodeEbaySkuAlias('PP1_A_5F_2FB')).toBe('A_/B');
  });

  it('refuses a SKU order import could not resolve, and an alias over 50 characters', () => {
    // Characters outside order import's Shopify SKU grammar (L77): a sale of
    // such a listing would freeze the ordered order pipeline.
    for (const sku of ["A'B", 'A+B', 'A"B', 'A\\B', '/AB', ' AB', 'AB ', 'Ä/B', '']) {
      expect(ebayInventorySkuFor(sku)).toBeNull();
    }
    expect(ebayInventorySkuFor('A/'.repeat(16))).toBeNull();
    const longest = ebayInventorySkuFor('ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQ/');
    expect(longest).toBe('PP1_ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQ_2F');
    expect(longest?.length).toBe(50);
    expect(ebayInventorySkuFor('ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQR/')).toBeNull();
  });

  it('reserves the PP1_ prefix so no Shopify SKU can collide with an alias', () => {
    expect(ebayInventorySkuFor('PP1_ILCE6400_2FB-U641')).toBeNull();
    expect(ebayInventorySkuFor('pp1_ilce6400_2fb-u641')).toBeNull();
    expect(ebayInventorySkuFor('PP1_A/B')).toBeNull();
    expect(ebaySkuMatchesShopifySku('PP1_ILCE6400_2FB-U641', 'PP1_ILCE6400_2FB-U641')).toBe(true);
    expect(ebayInventorySkuFor('PP1-ABC')).toBe('PP1-ABC');
  });

  it('matches a Shopify SKU only to its own bytes or its own alias', () => {
    expect(ebaySkuMatchesShopifySku('ILCE6400/B-U641', 'ILCE6400/B-U641')).toBe(true);
    expect(ebaySkuMatchesShopifySku('PP1_ILCE6400_2FB-U642', 'ILCE6400/B-U641')).toBe(false);
    expect(ebaySkuMatchesShopifySku('ILCE6400-B-U641', 'ILCE6400/B-U641')).toBe(false);
    expect(ebaySkuMatchesShopifySku('', 'A+B')).toBe(false);
  });
});
