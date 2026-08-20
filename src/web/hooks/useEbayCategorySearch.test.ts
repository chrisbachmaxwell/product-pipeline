import { describe, expect, it } from 'vitest';
import {
  EBAY_CATEGORY_QUERY_MAX_LENGTH,
  normalizeEbayCategoryQuery,
  normalizeEbayCategorySearchResponse,
} from './useEbayCategorySearch';

describe('normalizeEbayCategoryQuery', () => {
  it('trims, collapses whitespace, and lowercases searchable text', () => {
    expect(normalizeEbayCategoryQuery('  Studio   Lighting ')).toBe('studio lighting');
    expect(normalizeEbayCategoryQuery('Tripods\t&\nSupports')).toBe('tripods & supports');
  });

  it('keys equivalent queries identically', () => {
    expect(normalizeEbayCategoryQuery('LENS caps'))
      .toBe(normalizeEbayCategoryQuery('  lens   CAPS  '));
  });

  it('rejects blank and too-short input', () => {
    expect(normalizeEbayCategoryQuery('')).toBeNull();
    expect(normalizeEbayCategoryQuery('   ')).toBeNull();
    expect(normalizeEbayCategoryQuery('a')).toBeNull();
    expect(normalizeEbayCategoryQuery(' a ')).toBeNull();
  });

  it('accepts a 2-character query and the endpoint maximum', () => {
    expect(normalizeEbayCategoryQuery('ab')).toBe('ab');
    const max = 'x'.repeat(EBAY_CATEGORY_QUERY_MAX_LENGTH);
    expect(normalizeEbayCategoryQuery(max)).toBe(max);
  });

  it('rejects input longer than the endpoint accepts', () => {
    expect(normalizeEbayCategoryQuery('x'.repeat(EBAY_CATEGORY_QUERY_MAX_LENGTH + 1))).toBeNull();
  });

  it('never searches pure-numeric input (direct id entry)', () => {
    expect(normalizeEbayCategoryQuery('30088')).toBeNull();
    expect(normalizeEbayCategoryQuery('  42  ')).toBeNull();
  });

  it('still searches mixed alphanumeric input', () => {
    expect(normalizeEbayCategoryQuery('35mm film')).toBe('35mm film');
  });
});

describe('normalizeEbayCategorySearchResponse', () => {
  const item = {
    id: '30088',
    name: 'Other Lighting & Studio',
    path: 'Electronics > Cameras & Photo > Lighting & Studio > Other Lighting & Studio',
    leaf: true,
  };

  it('normalizes a well-formed payload', () => {
    expect(normalizeEbayCategorySearchResponse({ categories: [item] })).toEqual([item]);
  });

  it('returns an empty list for malformed payloads', () => {
    expect(normalizeEbayCategorySearchResponse(null)).toEqual([]);
    expect(normalizeEbayCategorySearchResponse('oops')).toEqual([]);
    expect(normalizeEbayCategorySearchResponse({})).toEqual([]);
    expect(normalizeEbayCategorySearchResponse({ categories: 'nope' })).toEqual([]);
    expect(normalizeEbayCategorySearchResponse([item])).toEqual([]);
  });

  it('drops entries without a usable id or name', () => {
    expect(normalizeEbayCategorySearchResponse({
      categories: [
        { ...item, id: '  ' },
        { ...item, name: '' },
        { ...item, id: 7 },
        null,
        'junk',
        item,
      ],
    })).toEqual([item]);
  });

  it('trims fields, defaults a missing path, and coerces leaf to a boolean', () => {
    expect(normalizeEbayCategorySearchResponse({
      categories: [{ id: ' 625 ', name: ' Cameras & Photo ', leaf: 'yes' }],
    })).toEqual([{ id: '625', name: 'Cameras & Photo', path: '', leaf: false }]);
  });

  it('deduplicates by id and caps the list at 25 results', () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      ...item,
      id: String(index % 30),
      name: `Category ${index}`,
    }));
    const results = normalizeEbayCategorySearchResponse({ categories: many });
    expect(results).toHaveLength(25);
    expect(new Set(results.map((result) => result.id)).size).toBe(25);
    expect(results[0]).toMatchObject({ id: '0', name: 'Category 0' });
  });
});
