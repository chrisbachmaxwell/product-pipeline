import { afterEach, describe, expect, it } from 'vitest';
import { getPublishAllStatus, releasePublishLock, startPublishAllRun, type PublishAllDependencies } from './publish-all.js';

// Incident #173: 5803C012-U230 failed Publish-All with the listing-lifecycle
// ceremony's catch-all LISTING_LIFECYCLE_DENIED — the code the ceremony prints
// when its own fresh store capture cannot read the row, which says nothing
// about the item itself.

const REVISION = `sha256:${'b'.repeat(64)}`;
const MANIFEST = `sha256:${'c'.repeat(64)}`;
const CATCH_ALL = { json: { command: 'preflight-create', status: 'denied', code: 'LISTING_LIFECYCLE_DENIED' } };

function row(variant: number, sku: string) {
  return {
    id: `shopify-variant:gid://shopify/ProductVariant/${variant}`,
    readyToList: true,
    shopify: { sku, title: `Item ${sku}` },
  };
}

const ROWS = [row(55484011184419, '5803C012-U230'), row(55484011184420, '4426B002-U317'), row(55484011184421, '8806A002-U025')];

function draftDto() {
  return {
    revision: { revisionDigest: REVISION },
    base: { sourceDigest: `sha256:${'d'.repeat(64)}`, ebayDigest: `sha256:${'e'.repeat(64)}` },
    sections: {
      listing: {
        title: { draft: null },
        category: { draft: null, shopify: null },
        conditionDescription: { draft: null, shopify: null },
      },
      content: { itemSpecifics: { draft: null, shopify: null } },
    },
  };
}

function skuOf(argv: readonly string[]): string {
  return argv[argv.indexOf('--sku') + 1]!;
}

function dependencies(
  rows: ReturnType<typeof row>[],
  preflight: (sku: string, call: number) => { json: Record<string, unknown> | null },
  calls: string[][],
  get: NonNullable<PublishAllDependencies['draftService']>['get'] = async () => draftDto(),
): PublishAllDependencies {
  const preflightCalls = new Map<string, number>();
  return {
    getSnapshot: async () => ({ rows }),
    draftService: {
      get,
      save: async () => ({ revision: { revisionDigest: REVISION } }),
    },
    fillAspects: null,
    findUnresolvedCreate: () => null,
    latestRevisionDigest: () => REVISION,
    agingUnresolvedCreateSkus: () => new Set(),
    runStep: async (argv) => {
      calls.push([argv[1]!, skuOf(argv)]);
      if (argv[1] === 'preflight-create') {
        const sku = skuOf(argv);
        const call = (preflightCalls.get(sku) ?? 0) + 1;
        preflightCalls.set(sku, call);
        return preflight(sku, call);
      }
      return { json: { status: 'created-and-reconciled', listingId: '147000000001' } };
    },
    sleep: async () => undefined,
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
  releasePublishLock();
});

describe('publish-all catch-all preflight refusal (incident #173)', () => {
  it('retries the item once at the end of the run and publishes it', async () => {
    arm();
    const calls: string[][] = [];
    const { run } = startPublishAllRun('test', dependencies(ROWS.slice(0, 2), (sku, call) =>
      sku === '5803C012-U230' && call <= 3 ? CATCH_ALL : { json: { status: 'preview', manifestDigest: MANIFEST } },
    calls));
    await run;
    const status = getPublishAllStatus();
    expect(status.state).toBe('finished');
    expect(status.items.map((item) => [item.sku, item.status])).toEqual([
      ['4426B002-U317', 'published'],
      ['5803C012-U230', 'published'],
    ]);
    // The deferred retry runs AFTER the rest of the queue.
    expect(calls.filter(([command]) => command === 'dispatch-create').map(([, sku]) => sku))
      .toEqual(['4426B002-U317', '5803C012-U230']);
  });

  it('drops an item that left the catalog mid-run instead of failing it', async () => {
    arm();
    const calls: string[][] = [];
    let gets = 0;
    const { run } = startPublishAllRun('test', dependencies(ROWS.slice(0, 1), () => CATCH_ALL, calls,
      async () => {
        gets += 1;
        if (gets === 1) return draftDto();
        throw Object.assign(new Error('gone'), { code: 'LISTING_DRAFT_NOT_FOUND' });
      }));
    await run;
    const status = getPublishAllStatus();
    expect(status.state).toBe('finished');
    expect(status.items).toEqual([]);
    expect(status.totalReady).toBe(0);
    expect(calls.filter(([command]) => command === 'preflight-create')).toHaveLength(3);
    expect(calls.some(([command]) => command === 'dispatch-create')).toBe(false);
  });

  it('retries only once: a persistent refusal fails with its code and never loops', async () => {
    arm();
    const calls: string[][] = [];
    const { run } = startPublishAllRun('test', dependencies(ROWS.slice(0, 2), (sku) =>
      sku === '5803C012-U230' ? CATCH_ALL : { json: { status: 'preview', manifestDigest: MANIFEST } },
    calls));
    await run;
    const status = getPublishAllStatus();
    expect(status.state).toBe('finished');
    const failed = status.items.find((item) => item.sku === '5803C012-U230');
    expect(failed?.status).toBe('failed');
    expect(failed?.reason).toContain('LISTING_LIFECYCLE_DENIED');
    expect(calls.filter(([command, sku]) => command === 'preflight-create' && sku === '5803C012-U230'))
      .toHaveLength(6);
    expect(calls.some(([command, sku]) => command === 'dispatch-create' && sku === '5803C012-U230'))
      .toBe(false);
  });

  it('still stops the run when three items in a row get the catch-all (systemic)', async () => {
    arm();
    const calls: string[][] = [];
    const { run } = startPublishAllRun('test', dependencies(ROWS, () => CATCH_ALL, calls));
    await run;
    const status = getPublishAllStatus();
    expect(status.state).toBe('stopped');
    expect(status.stopReason).toContain('Three consecutive preflight failures');
    expect(calls.some(([command]) => command === 'dispatch-create')).toBe(false);
  });
});
