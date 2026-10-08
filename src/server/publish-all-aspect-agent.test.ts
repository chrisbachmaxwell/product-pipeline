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

describe('publish-all draft from an older identity (incident #169)', () => {
  const noMissingAspects = async () => ({ available: true, aspects: [{ name: 'Brand', required: true }] });

  it('rebases a draft saved under an older SKU, then publishes the new revision', async () => {
    arm();
    const saves: unknown[] = [];
    const calls: string[][] = [];
    const { run } = startPublishAllRun('test', dependencies({
      getCategoryAspects: noMissingAspects,
      runStep: async (argv) => {
        calls.push([...argv]);
        if (argv[1] === 'preflight-create') {
          return argv.includes(REVISION)
            ? { json: { code: 'CREATE_IDENTITY_MISMATCH' } }
            : { json: { status: 'preview', manifestDigest: MANIFEST } };
        }
        return { json: { status: 'created-and-reconciled', listingId: '147000000001' } };
      },
    }, saves, calls));
    await run;
    expect(saves).toHaveLength(1);
    // The rebase is bound to the stale revision and keeps the operator's overrides.
    const saved = saves[0] as { expectedRevisionDigest: string; draft: { itemSpecifics: string } };
    expect(saved.expectedRevisionDigest).toBe(REVISION);
    expect(JSON.parse(saved.draft.itemSpecifics)).toEqual({ Brand: ['Canon'] });
    const preflights = calls.filter((argv) => argv[1] === 'preflight-create');
    expect(preflights).toHaveLength(2);
    expect(preflights[1]).toContain(SAVED);
    const dispatch = calls.find((argv) => argv[1] === 'dispatch-create');
    expect(dispatch).toContain(SAVED);
    expect(getPublishAllStatus().items[0]!.status).toBe('published');
  });

  it('skips with an actionable reason when the rebase save is refused', async () => {
    arm();
    const saves: unknown[] = [];
    const calls: string[][] = [];
    const base = dependencies({}, saves, calls);
    const { run } = startPublishAllRun('test', {
      ...base,
      getCategoryAspects: noMissingAspects,
      draftService: {
        get: base.draftService!.get,
        save: async () => { throw Object.assign(new Error('stale'), { code: 'LISTING_DRAFT_STALE' }); },
      },
      runStep: async (argv) => {
        calls.push([...argv]);
        return { json: { code: 'CREATE_IDENTITY_MISMATCH' } };
      },
    });
    await run;
    expect(calls.filter((argv) => argv[1] === 'dispatch-create')).toHaveLength(0);
    const item = getPublishAllStatus().items[0]!;
    expect(item.status).toBe('skipped');
    expect(item.reason).toContain('older SKU');
  });

  it('rebases only once: a mismatch that survives the rebase fails without looping', async () => {
    arm();
    const saves: unknown[] = [];
    const calls: string[][] = [];
    const { run } = startPublishAllRun('test', dependencies({
      getCategoryAspects: noMissingAspects,
      runStep: async (argv) => {
        calls.push([...argv]);
        return { json: { code: 'CREATE_IDENTITY_MISMATCH' } };
      },
    }, saves, calls));
    await run;
    expect(saves).toHaveLength(1);
    expect(calls.filter((argv) => argv[1] === 'preflight-create')).toHaveLength(2);
    expect(calls.filter((argv) => argv[1] === 'dispatch-create')).toHaveLength(0);
    const item = getPublishAllStatus().items[0]!;
    expect(item.status).toBe('failed');
    expect(item.reason).toBe('Preflight refused 4426B002-U317: CREATE_IDENTITY_MISMATCH');
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

describe('publish-all stuck-create sweep', () => {
  it('reconciles a create stuck over an hour even when eBay holds no leftover data', async () => {
    arm();
    process.env.PUBLISH_RECONCILE_ARGV = JSON.stringify(['cli.js', 'reconcile-create',
      '--sku', '{sku}', '--job-id', '{jobId}', '--attempt-id', '{attemptId}']);
    process.env.PUBLISH_RECOVER_ARGV = JSON.stringify(['cli.js', 'recover-create', '--sku', '{sku}']);
    process.env.PUBLISH_RECOVER_RECONCILE_ARGV = JSON.stringify(['cli.js', 'recover-reconcile', '--sku', '{sku}']);
    try {
      const saves: unknown[] = [];
      const calls: string[][] = [];
      const { run } = startPublishAllRun('test', dependencies({
        fillAspects: async () => ({ filled: { Mount: ['Canon RF'] }, unresolved: [] }),
        agingUnresolvedCreateSkus: () => new Set(['4426B002-U317']),
        findUnresolvedCreate: () => ({
          jobId: 'listing-create-job:1', attemptId: 'listing-create-attempt:1',
          intentKey: `sha256:${'1'.repeat(64)}`, evidenceDigest: `sha256:${'2'.repeat(64)}`,
        }),
      }, saves, calls));
      await run;
      expect(calls[0]).toEqual(['cli.js', 'reconcile-create', '--sku', '4426B002-U317',
        '--job-id', 'listing-create-job:1', '--attempt-id', 'listing-create-attempt:1']);
    } finally {
      delete process.env.PUBLISH_RECONCILE_ARGV;
      delete process.env.PUBLISH_RECOVER_ARGV;
      delete process.env.PUBLISH_RECOVER_RECONCILE_ARGV;
    }
  });
});

describe('publish-all dispatch refused after a clean preflight (incident #172)', () => {
  const noMissingAspects = async () => ({ available: true, aspects: [{ name: 'Brand', required: true }] });
  const denied = (code: string) => ({ json: { command: 'dispatch-create', status: 'denied', code } });

  it('re-checks a transient dispatch refusal once, then publishes', async () => {
    arm();
    const saves: unknown[] = [];
    const calls: string[][] = [];
    let dispatches = 0;
    const { run } = startPublishAllRun('test', dependencies({
      getCategoryAspects: noMissingAspects,
      runStep: async (argv) => {
        calls.push([...argv]);
        if (argv[1] === 'preflight-create') return { json: { status: 'preview', manifestDigest: MANIFEST } };
        dispatches += 1;
        return dispatches === 1
          ? denied('LISTING_LIFECYCLE_DENIED')
          // The ceremony's real success status.
          : { json: { status: 'dispatched-and-reconciled', listingId: '147000000001' } };
      },
    }, saves, calls));
    await run;
    expect(calls.map((argv) => argv[1])).toEqual([
      'preflight-create', 'dispatch-create', 'preflight-create', 'dispatch-create']);
    expect(getPublishAllStatus().items[0]).toMatchObject({ status: 'published', listingId: '147000000001' });
  });

  it('rebases when Shopify changed between preflight and dispatch, then dispatches the new revision', async () => {
    arm();
    const saves: unknown[] = [];
    const calls: string[][] = [];
    let preflights = 0;
    const { run } = startPublishAllRun('test', dependencies({
      getCategoryAspects: noMissingAspects,
      runStep: async (argv) => {
        calls.push([...argv]);
        if (argv[1] === 'preflight-create') {
          preflights += 1;
          return preflights === 2
            ? { json: { code: 'CREATE_BASE_STALE' } }
            : { json: { status: 'preview', manifestDigest: MANIFEST } };
        }
        return argv.includes(REVISION)
          ? denied('CREATE_BASE_STALE')
          : { json: { status: 'dispatched-and-reconciled', listingId: '147000000001' } };
      },
    }, saves, calls));
    await run;
    expect(saves).toHaveLength(1);
    const dispatches = calls.filter((argv) => argv[1] === 'dispatch-create');
    expect(dispatches).toHaveLength(2);
    expect(dispatches[1]).toContain(SAVED);
    expect(getPublishAllStatus().items[0]!.status).toBe('published');
  });

  it('re-checks only once and records the refusal code when it persists', async () => {
    arm();
    const saves: unknown[] = [];
    const calls: string[][] = [];
    const { run } = startPublishAllRun('test', dependencies({
      getCategoryAspects: noMissingAspects,
      runStep: async (argv) => {
        calls.push([...argv]);
        if (argv[1] === 'preflight-create') return { json: { status: 'preview', manifestDigest: MANIFEST } };
        return denied('LISTING_LIFECYCLE_DENIED');
      },
    }, saves, calls));
    await run;
    expect(calls.filter((argv) => argv[1] === 'dispatch-create')).toHaveLength(2);
    const item = getPublishAllStatus().items[0]!;
    expect(item.status).toBe('failed');
    expect(item.reason).toBe('The publish did not complete (denied: LISTING_LIFECYCLE_DENIED).');
  });

  it('never re-dispatches while the ledger holds an open create for the SKU', async () => {
    arm();
    const saves: unknown[] = [];
    const calls: string[][] = [];
    const { run } = startPublishAllRun('test', dependencies({
      getCategoryAspects: noMissingAspects,
      findUnresolvedCreate: () => ({
        jobId: 'listing-create-job:1', attemptId: 'listing-create-attempt:1',
        intentKey: `sha256:${'1'.repeat(64)}`, evidenceDigest: MANIFEST,
      }),
      runStep: async (argv) => {
        calls.push([...argv]);
        if (argv[1] === 'preflight-create') return { json: { status: 'preview', manifestDigest: MANIFEST } };
        return denied('LISTING_LIFECYCLE_DENIED');
      },
    }, saves, calls));
    await run;
    expect(calls.map((argv) => argv[1])).toEqual(['preflight-create', 'dispatch-create']);
    expect(getPublishAllStatus().items[0]!.status).toBe('failed');
  });

  it('does not re-check a refusal no preflight can clear', async () => {
    arm();
    const saves: unknown[] = [];
    const calls: string[][] = [];
    const { run } = startPublishAllRun('test', dependencies({
      getCategoryAspects: noMissingAspects,
      runStep: async (argv) => {
        calls.push([...argv]);
        if (argv[1] === 'preflight-create') return { json: { status: 'preview', manifestDigest: MANIFEST } };
        return denied('CREATE_OWNERSHIP_NOT_ESTABLISHED');
      },
    }, saves, calls));
    await run;
    expect(calls.map((argv) => argv[1])).toEqual(['preflight-create', 'dispatch-create']);
    expect(getPublishAllStatus().items[0]!.reason).toContain('CREATE_OWNERSHIP_NOT_ESTABLISHED');
  });
});
