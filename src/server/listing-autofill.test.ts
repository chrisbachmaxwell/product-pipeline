import { beforeEach, describe, expect, it } from 'vitest';
import {
  autofillListingAspects,
  createClaudeAspectProposer,
  missingAspectFromProviderMessage,
  resetAutofillMemo,
  validateProposals,
  type AspectProposer,
  type AutofillDraftDto,
} from './listing-autofill.js';

const CATALOG_ID = 'shopify-variant:gid://shopify/ProductVariant/1';
const SOURCE = `sha256:${'d'.repeat(64)}`;
const EBAY = `sha256:${'e'.repeat(64)}`;
const REVISION = `sha256:${'b'.repeat(64)}`;
const NEW_REVISION = `sha256:${'f'.repeat(64)}`;

function field(shopify: string | null, draft: string | null = null) {
  return { shopify, draft };
}

function dto(overrides: {
  revision?: boolean;
  itemSpecificsDraft?: string | null;
  categoryDraft?: string | null;
} = {}): AutofillDraftDto {
  return {
    revision: overrides.revision ? { revisionDigest: REVISION } : null,
    base: { sourceDigest: SOURCE, ebayDigest: EBAY },
    sections: {
      listing: {
        title: field('Canon EF 70-200mm f/2.8L IS II USM Lens *USED*'),
        category: field('3323', overrides.categoryDraft ?? null),
        condition: field('3000'),
        conditionDescription: field('Grade A — light wear.', overrides.revision ? 'Operator note.' : null),
      },
      content: {
        description: field('<p>Includes <b>hood</b> and caps.</p>'),
        images: field('["https://cdn.example/1.jpg"]'),
        itemSpecifics: field(JSON.stringify({ Brand: ['Canon'], MPN: ['2751B002'] }),
          overrides.itemSpecificsDraft ?? null),
      },
      delivery: {
        fulfillmentPolicyId: field('111'),
        paymentPolicyId: field('222'),
        returnPolicyId: field('333', overrides.revision ? '334' : null),
        merchantLocation: field('store'),
      },
    },
  };
}

const LENS_TAXONOMY = {
  available: true,
  aspects: [
    { name: 'Brand', required: true, mode: 'FREE_TEXT' as const, values: ['Canon'] },
    { name: 'Mount', required: true, mode: 'SELECTION_ONLY' as const, values: ['Canon EF', 'Nikon F'] },
    { name: 'Focal Length', required: true, mode: 'FREE_TEXT' as const, values: [] },
    { name: 'Model', required: false, mode: 'FREE_TEXT' as const, values: [] },
    { name: 'Color', required: false, mode: 'FREE_TEXT' as const, values: [] },
  ],
};

function service(current: AutofillDraftDto) {
  const saves: Array<{ request: Record<string, unknown>; actor: string }> = [];
  return {
    saves,
    draftService: {
      get: async () => current,
      save: async (request: unknown, actor: string) => {
        saves.push({ request: request as Record<string, unknown>, actor });
        return { revision: { revisionDigest: NEW_REVISION } };
      },
    },
  };
}

beforeEach(() => resetAutofillMemo());

describe('autofillListingAspects', () => {
  it('fills missing required aspects, merges the source set, and saves a local draft', async () => {
    const harness = service(dto());
    const asked: string[][] = [];
    const propose: AspectProposer = async (input) => {
      asked.push(input.needed.map((aspect) => aspect.name));
      expect(input.description).toBe('Includes hood and caps.');
      return [
        { name: 'mount', value: 'canon ef' },
        { name: 'Focal Length', value: '70-200mm' },
        { name: 'Model', value: 'EF 70-200mm f/2.8L IS II USM' },
      ];
    };
    const result = await autofillListingAspects(CATALOG_ID, {
      draftService: harness.draftService,
      getCategoryAspects: async () => LENS_TAXONOMY,
      propose,
    });
    // Required gaps plus the best-effort Model (Color is never asked).
    expect(asked).toEqual([['Mount', 'Focal Length', 'Model']]);
    expect(result).toEqual({
      status: 'filled',
      filled: ['Mount', 'Focal Length', 'Model'],
      stillMissing: [],
      revisionDigest: NEW_REVISION,
    });
    expect(harness.saves).toHaveLength(1);
    const draft = harness.saves[0].request.draft as Record<string, unknown>;
    // Canonical eBay value casing, sorted keys, source aspects kept.
    expect(draft.itemSpecifics).toBe(JSON.stringify({
      Brand: ['Canon'], 'Focal Length': ['70-200mm'], MPN: ['2751B002'],
      Model: ['EF 70-200mm f/2.8L IS II USM'], Mount: ['Canon EF'],
    }));
    // First draft carries the publish-all condition note; everything else inherits.
    expect(draft.conditionDescription).toBe('Grade A — light wear. The photographs show the exact item for sale.');
    expect(draft.category).toBeNull();
    expect(draft.returnPolicyId).toBeNull();
    expect(harness.saves[0].request.expectedRevisionDigest).toBeNull();
  });

  it('preserves every existing operator draft leaf when it saves', async () => {
    const harness = service(dto({ revision: true, categoryDraft: '3323' }));
    await autofillListingAspects(CATALOG_ID, {
      draftService: harness.draftService,
      getCategoryAspects: async () => LENS_TAXONOMY,
      propose: async () => [{ name: 'Mount', value: 'Canon EF' }, { name: 'Focal Length', value: '200mm' }],
    });
    const request = harness.saves[0].request;
    const draft = request.draft as Record<string, unknown>;
    expect(request.expectedRevisionDigest).toBe(REVISION);
    expect(draft.conditionDescription).toBe('Operator note.');
    expect(draft.returnPolicyId).toBe('334');
    expect(draft.category).toBe('3323');
  });

  it('reports what a person still has to fill and never saves when nothing validates', async () => {
    const harness = service(dto());
    const result = await autofillListingAspects(CATALOG_ID, {
      draftService: harness.draftService,
      getCategoryAspects: async () => LENS_TAXONOMY,
      // Not an eBay value for a SELECTION_ONLY aspect; placeholder text.
      propose: async () => [{ name: 'Mount', value: 'Canon RF' }, { name: 'Focal Length', value: 'Unknown' }],
    });
    expect(result.status).toBe('incomplete');
    expect(result.stillMissing).toEqual(['Mount', 'Focal Length']);
    expect(harness.saves).toHaveLength(0);
  });

  it('without a Claude connection, still reports the gaps', async () => {
    const harness = service(dto());
    const result = await autofillListingAspects(CATALOG_ID, {
      draftService: harness.draftService,
      getCategoryAspects: async () => LENS_TAXONOMY,
      propose: null,
    });
    expect(result).toMatchObject({ status: 'incomplete', stillMissing: ['Mount', 'Focal Length'] });
  });

  it('asks Claude once per item per source state, not every pass', async () => {
    const harness = service(dto());
    let calls = 0;
    const dependencies = {
      draftService: harness.draftService,
      getCategoryAspects: async () => LENS_TAXONOMY,
      propose: async () => { calls += 1; return []; },
      now: () => 1_000,
    };
    await autofillListingAspects(CATALOG_ID, dependencies);
    await autofillListingAspects(CATALOG_ID, dependencies);
    expect(calls).toBe(1);
  });

  it('treats an aspect eBay refused at publish as blocking, even if unlisted', async () => {
    const harness = service(dto({ itemSpecificsDraft: JSON.stringify({
      Brand: ['Canon'], 'Focal Length': ['200mm'], Model: ['X'], Mount: ['Canon EF'],
    }) }));
    let needed: string[] = [];
    const result = await autofillListingAspects(CATALOG_ID, {
      draftService: harness.draftService,
      getCategoryAspects: async () => LENS_TAXONOMY,
      propose: async (input) => {
        needed = input.needed.map((aspect) => aspect.name);
        return [{ name: 'Focus Type', value: 'Auto & Manual' }];
      },
    }, { extraAspects: ['Focus Type'] });
    expect(needed).toEqual(['Focus Type']);
    expect(result).toMatchObject({ status: 'filled', filled: ['Focus Type'], stillMissing: [] });
  });

  it('is a no-op when nothing is missing or the category is unknown', async () => {
    const complete = service(dto({ itemSpecificsDraft: JSON.stringify({
      Brand: ['Canon'], 'Focal Length': ['200mm'], Model: ['X'], Mount: ['Canon EF'],
    }) }));
    expect(await autofillListingAspects(CATALOG_ID, {
      draftService: complete.draftService,
      getCategoryAspects: async () => LENS_TAXONOMY,
      propose: async () => { throw new Error('must not be called'); },
    })).toMatchObject({ status: 'complete', filled: [] });

    const unavailable = await autofillListingAspects(CATALOG_ID, {
      draftService: service(dto()).draftService,
      getCategoryAspects: async () => ({ available: false, aspects: [] }),
      propose: null,
    });
    expect(unavailable.status).toBe('unavailable');
  });
});

describe('validateProposals', () => {
  it('drops unknown names, duplicates, long values, and off-list selections', () => {
    expect(validateProposals([
      { name: 'Type', mode: 'SELECTION_ONLY', values: ['Zoom', 'Prime'] },
      { name: 'Series', mode: 'FREE_TEXT', values: [] },
    ], [
      { name: 'type', value: 'ZOOM' },
      { name: 'Type', value: 'Prime' },
      { name: 'Series', value: 'x'.repeat(66) },
      { name: 'Color', value: 'Black' },
    ])).toEqual({ Type: ['Zoom'] });
  });
});

describe('missingAspectFromProviderMessage', () => {
  it('reads the aspect name out of eBay 25002', () => {
    expect(missingAspectFromProviderMessage(
      'The item specific Focus Type is missing. Add Focus Type to this listing, enter a valid value, and then try again.',
    )).toBe('Focus Type');
    expect(missingAspectFromProviderMessage('Some other error.')).toBeNull();
    expect(missingAspectFromProviderMessage(null)).toBeNull();
  });
});

describe('createClaudeAspectProposer', () => {
  it('is unarmed without a key', async () => {
    expect(await createClaudeAspectProposer({ readKey: () => null })).toBeNull();
  });

  it('sends a structured-output request and parses the aspects', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const propose = await createClaudeAspectProposer({
      readKey: () => ({ key: 'test-key' }),
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '{"aspects":[{"name":"Mount","value":"Canon EF"}]}' }],
        }), { status: 200 });
      }) as typeof fetch,
    });
    const result = await propose!({
      title: 'Canon EF 50mm', description: null, existing: {},
      needed: [{ name: 'Mount', mode: 'SELECTION_ONLY', values: ['Canon EF'] }],
    });
    expect(result).toEqual([{ name: 'Mount', value: 'Canon EF' }]);
    expect(bodies[0]).toMatchObject({ output_config: { format: { type: 'json_schema' } } });
    expect(String((bodies[0].messages as Array<{ content: string }>)[0].content)).toContain('must be one of: Canon EF');
  });

  it('retries without the fallback beta on a 400 and returns nothing on refusal', async () => {
    const withBeta: boolean[] = [];
    const propose = await createClaudeAspectProposer({
      readKey: () => ({ key: 'test-key' }),
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        withBeta.push('fallbacks' in body);
        if ('fallbacks' in body) return new Response('{}', { status: 400 });
        return new Response(JSON.stringify({ stop_reason: 'refusal', content: [] }), { status: 200 });
      }) as typeof fetch,
    });
    expect(await propose!({ title: 't', description: null, existing: {}, needed: [] })).toEqual([]);
    expect(withBeta).toEqual([true, false]);
  });
});
