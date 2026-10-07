import { afterEach, describe, expect, it } from 'vitest';
import { getPublishAllStatus, releasePublishLock, startPublishAllRun, type PublishAllDependencies } from './publish-all.js';

const CATALOG_ID = 'shopify-variant:gid://shopify/ProductVariant/55484011184419';
const REVISION = `sha256:${'b'.repeat(64)}`;
const SAVED = `sha256:${'f'.repeat(64)}`;
const MANIFEST = `sha256:${'c'.repeat(64)}`;

function dependencies(overrides: Partial<PublishAllDependencies>, saves: unknown[], calls: string[][]): PublishAllDependencies {
  return {
    getSnapshot: async () => ({ rows: [{
      id: CATALOG_ID, readyToList: true,
      shopify: { sku: '4426B002-U317', title: 'Canon RF 24-105mm f/4-7.1 IS STM Lens' },
    }] }),
    draftService: {
      get: async () => ({
        revision: { revisionDigest: REVISION },
        base: { sourceDigest: `sha256:${'d'.repeat(64)}`, ebayDigest: `sha256:${'e'.repeat(64)}` },
        sections: {
          listing: {
            title: { draft: null },
            category: { draft: null, shopify: '3323' },
            conditionDescription: { draft: null, shopify: null },
          },
          content: { itemSpecifics: { draft: JSON.stringify({ Brand: ['Canon'] }), shopify: null } },
        },
      }),
      save: async (payload) => { saves.push(payload); return { revision: { revisionDigest: SAVED } }; },
    },
    getCategoryAspects: async () => ({ available: true, aspects: [
      { name: 'Brand', required: true },
      { name: 'Mount', required: true, mode: 'SELECTION_ONLY', values: ['Canon RF'] },
    ] }),
    findUnresolvedCreate: () => null,
    latestRevisionDigest: () => SAVED,
    runStep: async (argv) => {
      calls.push([...argv]);
      if (argv[1] === 'preflight-create') return { json: { status: 'preview', manifestDigest: MANIFEST } };
      return { json: { status: 'created-and-reconciled', listingId: '147000000001' } };
    },
    sleep: async () => undefined,
    ...overrides,
  };
}

function arm(): void {
  process.env.PUBLISH_PREFLIGHT_ARGV = JSON.stringify(['cli.js', 'preflight-create',
    '--catalog-id', '{catalogId}', '--sku', '{sku}', '--revision-digest', '{revisionDigest}']);
  process.env.PUBLISH_DISPATCH_ARGV = JSON.stringify(['cli.js', 'dispatch-create',
    '--catalog-id', '{catalogId}', '--sku', '{sku}', '--revision-digest', '{revisionDigest}',
    '--manifest-digest', '{manifestDigest}']);
}

afterEach(() => {
  delete process.env.PUBLISH_PREFLIGHT_ARGV;
  delete process.env.PUBLISH_DISPATCH_ARGV;
  delete process.env.PUBLISH_EXCLUDE_SKUS;
  releasePublishLock();
});

describe('publish-all item-specifics agent', () => {
  it('writes confident missing aspects into the draft, then publishes that revision', async () => {
    arm();
    const saves: unknown[] = [];
    const calls: string[][] = [];
    const { run } = startPublishAllRun('test', dependencies({
      fillAspects: async () => ({ filled: { Mount: ['Canon RF'] }, unresolved: [] }),
    }, saves, calls));
    await run;
    const saved = saves[0] as { draft: { itemSpecifics: string } };
    expect(JSON.parse(saved.draft.itemSpecifics)).toEqual({ Brand: ['Canon'], Mount: ['Canon RF'] });
    expect(calls[0]).toContain(SAVED);
    const item = getPublishAllStatus().items[0];
    expect(item.status).toBe('published');
    expect(item.reason).toContain('Mount = Canon RF');
  });

  it('skips with the remaining names when the agent is not certain', async () => {
    arm();
    const saves: unknown[] = [];
    const calls: string[][] = [];
    const { run } = startPublishAllRun('test', dependencies({
      fillAspects: async () => ({ filled: {}, unresolved: ['Mount'] }),
    }, saves, calls));
    await run;
    expect(saves).toHaveLength(0);
    expect(calls).toHaveLength(0);
    const item = getPublishAllStatus().items[0];
    expect(item.status).toBe('skipped');
    expect(item.reason).toContain('eBay requires Mount');
  });

  it('never touches an excluded SKU', async () => {
    arm();
    process.env.PUBLISH_EXCLUDE_SKUS = 'OTHER-1, 4426B002-U317';
    const saves: unknown[] = [];
    const calls: string[][] = [];
    let asked = false;
    const { run } = startPublishAllRun('test', dependencies({
      fillAspects: async () => { asked = true; return { filled: {}, unresolved: [] }; },
    }, saves, calls));
    await run;
    expect(asked).toBe(false);
    expect(calls).toHaveLength(0);
    expect(getPublishAllStatus().totalReady).toBe(0);
  });
});

describe('publish-all progress reporting', () => {
  it('names the step in progress and clears the item once it is recorded', async () => {
    arm();
    const saves: unknown[] = [];
    const calls: string[][] = [];
    const seen: Array<{ sku: string | null; step: string | null }> = [];
    const { run } = startPublishAllRun('test', dependencies({
      fillAspects: async () => ({ filled: { Mount: ['Canon RF'] }, unresolved: [] }),
      sleep: async () => {
        const current = getPublishAllStatus();
        seen.push({ sku: current.currentSku, step: current.currentStep });
      },
    }, saves, calls));
    await run;
    expect(seen).toContainEqual({ sku: '4426B002-U317', step: 'Pausing 40s before publishing (Shopify rate limit)' });
    // The only item is the last one: no trailing pause after it is recorded.
    expect(seen.some((entry) => entry.sku === null)).toBe(false);
    const done = getPublishAllStatus();
    expect(done.state).toBe('finished');
    expect(done.currentStep).toBeNull();
  });
});
