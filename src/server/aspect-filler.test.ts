import { describe, expect, it } from 'vitest';
import { acceptAspectAnswer, fillMissingAspects, type AspectFillRequest } from './aspect-filler.js';

const REQUEST: AspectFillRequest = {
  title: 'Canon EF 50mm f/1.8 STM Lens (#317) *USED*',
  description: '<p>Great lens</p>',
  categoryId: '3323',
  existing: { Brand: ['Canon'] },
  missing: [
    { name: 'Mount', mode: 'SELECTION_ONLY', values: ['Canon EF', 'Nikon F'] },
    { name: 'Focal Length', mode: 'FREE_TEXT', values: [] },
    { name: 'Type', mode: 'FREE_TEXT', values: [] },
  ],
};

describe('aspect filler', () => {
  it('accepts confident answers, canonicalizes selection values, drops unsure ones', () => {
    const result = acceptAspectAnswer(REQUEST, JSON.stringify({ aspects: [
      { name: 'mount', value: 'canon ef', confident: true },
      { name: 'Focal Length', value: '50mm', confident: true },
      { name: 'Type', value: 'Standard', confident: false },
    ] }));
    expect(result.filled).toEqual({ Mount: ['Canon EF'], 'Focal Length': ['50mm'] });
    expect(result.unresolved).toEqual(['Type']);
  });

  it('rejects a selection-only value eBay does not offer and over-long values', () => {
    const result = acceptAspectAnswer(REQUEST, JSON.stringify({ aspects: [
      { name: 'Mount', value: 'Canon RF', confident: true },
      { name: 'Focal Length', value: 'x'.repeat(66), confident: true },
    ] }));
    expect(result.filled).toEqual({});
    expect(result.unresolved).toEqual(['Mount', 'Focal Length', 'Type']);
  });

  it('ignores aspects that were not asked for and malformed answers', () => {
    expect(acceptAspectAnswer(REQUEST, JSON.stringify({ aspects: [
      { name: 'Color', value: 'Black', confident: true },
    ] })).filled).toEqual({});
    expect(acceptAspectAnswer(REQUEST, 'not json').unresolved).toHaveLength(3);
  });

  it('fills nothing when the model call fails', async () => {
    const result = await fillMissingAspects(REQUEST, async () => { throw new Error('http 500'); });
    expect(result).toEqual({ filled: {}, unresolved: ['Mount', 'Focal Length', 'Type'] });
  });

  it('sends the item text and the allowed values to the model', async () => {
    let prompt = '';
    await fillMissingAspects(REQUEST, async (_system, user) => {
      prompt = user;
      return JSON.stringify({ aspects: [] });
    });
    expect(prompt).toContain(REQUEST.title);
    expect(prompt).toContain('Great lens');
    expect(prompt).toContain('Mount (choose exactly one of: Canon EF | Nikon F)');
  });
});
