import { afterEach, describe, expect, it } from 'vitest';
import { fitEbayTitle, getPublishAllStatus, releasePublishLock, startPublishAllRun, type PublishAllDependencies } from './publish-all.js';

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
  it('reuses the fresh initial snapshot instead of forcing a second provider census', async () => {
    arm();
    const saves: unknown[] = [];
    const calls: string[][] = [];
    let forcedRefreshes = 0;
    const { run } = startPublishAllRun('test', dependencies({
      fillAspects: async () => ({ filled: { Mount: ['Canon RF'] }, unresolved: [] }),
      refreshSnapshot: async () => {
        forcedRefreshes += 1;
        throw new Error('provider census should not run');
      },
    }, saves, calls));
    await run;
    expect(forcedRefreshes).toBe(0);
    expect(getPublishAllStatus().items[0]).toMatchObject({ status: 'published' });
  });

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
      const configured = dependencies({
        fillAspects: async () => ({ filled: { Mount: ['Canon RF'] }, unresolved: [] }),
        agingUnresolvedCreateSkus: () => new Set(['4426B002-U317']),
        findUnresolvedCreate: () => ({
          jobId: 'listing-create-job:1', attemptId: 'listing-create-attempt:1',
          intentKey: `sha256:${'1'.repeat(64)}`, evidenceDigest: `sha256:${'2'.repeat(64)}`,
        }),
      }, saves, calls);
      const initialSnapshot = configured.getSnapshot!;
      let forcedRefreshes = 0;
      const { run } = startPublishAllRun('test', {
        ...configured,
        refreshSnapshot: async () => {
          forcedRefreshes += 1;
          return initialSnapshot();
        },
      });
      await run;
      expect(calls[0]).toEqual(['cli.js', 'reconcile-create', '--sku', '4426B002-U317',
        '--job-id', 'listing-create-job:1', '--attempt-id', 'listing-create-attempt:1']);
      expect(forcedRefreshes).toBe(1);
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

describe('publish-all title over eBay\'s 80 characters (incident #180)', () => {
  const noMissingAspects = async () => ({ available: true, aspects: [{ name: 'Brand', required: true }] });
  const LONG = 'Fujifilm Fujinon EBC 180mm f/5.6 Large Format View Camera Lens with Copal 1 Shutter (#005) *USED*';

  function withTitle(base: PublishAllDependencies, shopifyTitle: string, draftTitle: string | null = null): PublishAllDependencies {
    return {
      ...base,
      getSnapshot: async () => ({ rows: [{
        id: CATALOG_ID, readyToList: true, shopify: { sku: 'FUJIEBC180MM-U005', title: shopifyTitle },
      }] }),
      draftService: {
        get: async () => {
          const dto = await base.draftService!.get(CATALOG_ID);
          return { ...dto, sections: { ...dto.sections, listing: {
            ...dto.sections.listing, title: { draft: draftTitle, shopify: shopifyTitle },
          } } };
        },
        save: base.draftService!.save,
      },
    };
  }

  it('shortens a long store title into the draft, then publishes that revision', async () => {
    arm();
    const saves: unknown[] = [];
    const calls: string[][] = [];
    const { run } = startPublishAllRun('test', withTitle(
      dependencies({ getCategoryAspects: noMissingAspects }, saves, calls), LONG));
    await run;
    expect(saves).toHaveLength(1);
    const saved = saves[0] as { expectedRevisionDigest: string; draft: { title: string; itemSpecifics: string } };
    expect(saved.draft.title.length).toBeLessThanOrEqual(80);
    expect(saved.draft.title).toBe(fitEbayTitle(LONG));
    expect(saved.expectedRevisionDigest).toBe(REVISION);
    // The operator's other overrides survive the save.
    expect(JSON.parse(saved.draft.itemSpecifics)).toEqual({ Brand: ['Canon'] });
    expect(calls.map((argv) => argv[1])).toEqual(['preflight-create', 'dispatch-create']);
    expect(calls[0]).toContain(SAVED);
    expect(getPublishAllStatus().items[0]!.status).toBe('published');
  });

  it('leaves a title that already fits, and an operator title, untouched', async () => {
    arm();
    for (const [shopify, draft] of [['Canon RF 24-105mm f/4-7.1 IS STM Lens', null], [LONG, 'Fujinon EBC 180mm f/5.6']] as const) {
      const saves: unknown[] = [];
      const calls: string[][] = [];
      const { run } = startPublishAllRun('test', withTitle(
        dependencies({ getCategoryAspects: noMissingAspects }, saves, calls), shopify, draft));
      await run;
      expect(saves).toHaveLength(0);
      expect(calls[0]).toContain(REVISION);
      expect(getPublishAllStatus().items[0]!.status).toBe('published');
      releasePublishLock();
    }
  });

  it('skips a title-less item with its own reason and never calls a ceremony', async () => {
    arm();
    const saves: unknown[] = [];
    const calls: string[][] = [];
    const { run } = startPublishAllRun('test', withTitle(
      dependencies({ getCategoryAspects: noMissingAspects }, saves, calls), '   '));
    await run;
    expect(calls).toHaveLength(0);
    const item = getPublishAllStatus().items[0]!;
    expect(item.status).toBe('skipped');
    expect(item.reason).toContain('no title in Shopify');
  });

  // Incident #182: the fit save was refused once (swallowed), and every
  // other Publish-All save wrote the title back to inherit, so the item
  // skipped "could not be shortened" on every run.
  function refusingSaves(base: PublishAllDependencies, refusals: number): PublishAllDependencies {
    let left = refusals;
    return { ...base, draftService: { get: base.draftService!.get, save: async (payload, actor) => {
      if (left > 0) {
        left -= 1;
        throw Object.assign(new Error('stale'), { code: 'LISTING_DRAFT_STALE' });
      }
      return base.draftService!.save(payload, actor);
    } } };
  }

  it('retries a refused title-fit save from a fresh read (incident #182)', async () => {
    arm();
    const saves: unknown[] = [];
    const calls: string[][] = [];
    const { run } = startPublishAllRun('test', refusingSaves(withTitle(
      dependencies({ getCategoryAspects: noMissingAspects }, saves, calls), LONG), 1));
    await run;
    expect((saves[0] as { draft: { title: string } }).draft.title).toBe(fitEbayTitle(LONG));
    expect(calls[0]).toContain(SAVED);
    expect(getPublishAllStatus().items[0]!.status).toBe('published');
  });

  it('repairs the title once when preflight still refuses it (incident #182)', async () => {
    arm();
    const saves: unknown[] = [];
    const calls: string[][] = [];
    const base = withTitle(dependencies({
      getCategoryAspects: noMissingAspects,
      runStep: async (argv) => {
        calls.push([...argv]);
        if (argv[1] === 'preflight-create') {
          return argv.includes(SAVED)
            ? { json: { status: 'preview', manifestDigest: MANIFEST } }
            : { json: { status: 'denied', code: 'CREATE_REQUIRED_FIELD_MISSING', field: 'title' } };
        }
        return { json: { status: 'dispatched-and-reconciled', listingId: '147000000001' } };
      },
    }, saves, calls), LONG);
    const { run } = startPublishAllRun('test', refusingSaves(base, 2));
    await run;
    expect(saves).toHaveLength(1);
    expect((saves[0] as { draft: { title: string } }).draft.title).toBe(fitEbayTitle(LONG));
    expect(calls.map((argv) => argv[1])).toEqual(['preflight-create', 'preflight-create', 'dispatch-create']);
    expect(getPublishAllStatus().items[0]!.status).toBe('published');
  });

  it('keeps the fitted title in a stale-base rebase save (incident #182)', async () => {
    arm();
    const saves: unknown[] = [];
    const calls: string[][] = [];
    let preflights = 0;
    const base = withTitle(dependencies({
      getCategoryAspects: noMissingAspects,
      runStep: async (argv) => {
        calls.push([...argv]);
        if (argv[1] === 'preflight-create') {
          preflights += 1;
          return preflights === 1
            ? { json: { status: 'denied', code: 'CREATE_BASE_STALE' } }
            : { json: { status: 'preview', manifestDigest: MANIFEST } };
        }
        return { json: { status: 'dispatched-and-reconciled', listingId: '147000000001' } };
      },
    }, saves, calls), LONG);
    const { run } = startPublishAllRun('test', base);
    await run;
    expect(saves.length).toBeGreaterThanOrEqual(2);
    for (const saved of saves) {
      expect((saved as { draft: { title: string } }).draft.title).toBe(fitEbayTitle(LONG));
    }
    expect(getPublishAllStatus().items[0]!.status).toBe('published');
  });

  // Incident #184: the stored revision inherited a long store title that has
  // since been shortened in Shopify. The manifest checks the title before
  // base freshness, so preflight says `title` (never CREATE_BASE_STALE), and
  // the fresh read shows a title that fits — the fit-only repair saved
  // nothing and the item skipped on every run.
  it('refreshes a revision whose long inherited title was shortened in Shopify (incident #184)', async () => {
    arm();
    const saves: unknown[] = [];
    const calls: string[][] = [];
    const SHORT = 'Fujifilm Fujinon EBC 180mm f/5.6 Large Format Lens';
    const { run } = startPublishAllRun('test', refusingSaves(withTitle(dependencies({
      getCategoryAspects: noMissingAspects,
      runStep: async (argv) => {
        calls.push([...argv]);
        if (argv[1] === 'preflight-create') {
          return argv.includes(SAVED)
            ? { json: { status: 'preview', manifestDigest: MANIFEST } }
            : { json: { status: 'denied', code: 'CREATE_REQUIRED_FIELD_MISSING', field: 'title' } };
        }
        return { json: { status: 'dispatched-and-reconciled', listingId: '147000000001' } };
      },
    }, saves, calls), SHORT), 1));
    await run;
    // One refused refresh (logged, retried), then a re-inheriting save.
    expect(saves).toHaveLength(1);
    const saved = saves[0] as { expectedRevisionDigest: string; draft: { title: string | null; itemSpecifics: string } };
    expect(saved.draft.title).toBeNull();
    expect(saved.expectedRevisionDigest).toBe(REVISION);
    expect(JSON.parse(saved.draft.itemSpecifics)).toEqual({ Brand: ['Canon'] });
    expect(calls.map((argv) => argv[1])).toEqual(['preflight-create', 'preflight-create', 'dispatch-create']);
    expect(calls[2]).toContain(SAVED);
    expect(getPublishAllStatus().items[0]!.status).toBe('published');
  });

  it('skips with the title reason when the refresh cannot land', async () => {
    arm();
    const saves: unknown[] = [];
    const calls: string[][] = [];
    const { run } = startPublishAllRun('test', refusingSaves(withTitle(dependencies({
      getCategoryAspects: noMissingAspects,
      runStep: async (argv) => {
        calls.push([...argv]);
        return { json: { status: 'denied', code: 'CREATE_REQUIRED_FIELD_MISSING', field: 'title' } };
      },
    }, saves, calls), 'Fujinon EBC 180mm f/5.6'), 2));
    await run;
    expect(saves).toHaveLength(0);
    expect(calls.map((argv) => argv[1])).toEqual(['preflight-create']);
    const item = getPublishAllStatus().items[0]!;
    expect(item.status).toBe('skipped');
    expect(item.reason).toContain('1–80 characters');
  });

  it('fits titles to whole words without store markers', () => {
    expect(fitEbayTitle('Canon EF 50mm f/1.8 *USED*')).toBe('Canon EF 50mm f/1.8 *USED*');
    const fitted = fitEbayTitle(LONG)!;
    expect(fitted).toBe('Fujifilm Fujinon EBC 180mm f/5.6 Large Format View Camera Lens with Copal 1');
    expect(fitted.length).toBeLessThanOrEqual(80);
    const unbroken = fitEbayTitle('X'.repeat(120))!;
    expect(unbroken).toHaveLength(80);
    expect(fitEbayTitle('  ')).toBeNull();
    expect(fitEbayTitle(null)).toBeNull();
  });
});

// Incident #186: the create manifest checks every required field BEFORE base
// freshness, so a draft saved while the store's photos could not be read (or
// before they were uploaded) reported `images` on every run, never
// CREATE_BASE_STALE, and Publish-All only refreshed for `title`.
describe('publish-all draft without images (incident #186)', () => {
  const noMissingAspects = async () => ({ available: true, aspects: [{ name: 'Brand', required: true }] });
  const PHOTOS = JSON.stringify(['https://cdn.shopify.com/s/files/1/a.jpg']);

  function withImages(base: PublishAllDependencies, imageCount: number | undefined, imageOverride: string | null = null, imageSource: string | null = null): PublishAllDependencies {
    return {
      ...base,
      getSnapshot: async () => ({ rows: [{
        id: CATALOG_ID, readyToList: true,
        shopify: { sku: 'SEL100400GM-U665', title: 'Sony FE 100-400mm f/4.5-5.6 GM OSS Lens', imageCount },
      }] }),
      draftService: {
        get: async () => {
          const dto = await base.draftService!.get(CATALOG_ID);
          return { ...dto, sections: { ...dto.sections, content: {
            ...dto.sections.content, images: { draft: imageOverride, shopify: imageSource },
          } } };
        },
        save: base.draftService!.save,
      },
    };
  }

  const deniesImagesUntilSaved = (calls: string[][]): PublishAllDependencies['runStep'] => async (argv) => {
    calls.push([...argv]);
    if (argv[1] === 'preflight-create') {
      return argv.includes(SAVED)
        ? { json: { status: 'preview', manifestDigest: MANIFEST } }
        : { json: { status: 'denied', code: 'CREATE_REQUIRED_FIELD_MISSING', field: 'images' } };
    }
    return { json: { status: 'dispatched-and-reconciled', listingId: '147000000001' } };
  };

  it('refreshes a stored revision that predates the store photos, then publishes it', async () => {
    arm();
    const saves: unknown[] = [];
    const calls: string[][] = [];
    const { run } = startPublishAllRun('test', withImages(dependencies({
      getCategoryAspects: noMissingAspects, runStep: deniesImagesUntilSaved(calls),
    }, saves, calls), 6));
    await run;
    expect(saves).toHaveLength(1);
    const saved = saves[0] as { expectedRevisionDigest: string; draft: { images: string | null } };
    expect(saved.expectedRevisionDigest).toBe(REVISION);
    expect(saved.draft.images).toBeNull(); // re-inherits the store photos
    expect(calls.map((argv) => argv[1])).toEqual(['preflight-create', 'preflight-create', 'dispatch-create']);
    expect(calls[2]).toContain(SAVED);
    expect(getPublishAllStatus().items[0]!.status).toBe('published');
  });

  it('carries an operator photo override through every Publish-All save', async () => {
    arm();
    const saves: unknown[] = [];
    const calls: string[][] = [];
    const { run } = startPublishAllRun('test', withImages(dependencies({
      getCategoryAspects: noMissingAspects, runStep: deniesImagesUntilSaved(calls),
    }, saves, calls), 0, PHOTOS));
    await run;
    expect(saves).toHaveLength(1);
    expect((saves[0] as { draft: { images: string | null } }).draft.images).toBe(PHOTOS);
    expect(getPublishAllStatus().items[0]!.status).toBe('published');
  });

  it('skips a product with no photos in Shopify before any ceremony', async () => {
    arm();
    const saves: unknown[] = [];
    const calls: string[][] = [];
    const { run } = startPublishAllRun('test', withImages(dependencies({
      getCategoryAspects: noMissingAspects, runStep: deniesImagesUntilSaved(calls),
    }, saves, calls), 0));
    await run;
    expect(saves).toHaveLength(0);
    expect(calls).toHaveLength(0);
    const item = getPublishAllStatus().items[0]!;
    expect(item.status).toBe('skipped');
    expect(item.reason).toContain('no photos in Shopify');
  });

  it('publishes when the run-start photo count is 0 but the fresh read finds store photos (incident #194)', async () => {
    arm();
    const saves: unknown[] = [];
    const calls: string[][] = [];
    const { run } = startPublishAllRun('test', withImages(dependencies({
      getCategoryAspects: noMissingAspects,
    }, saves, calls), 0, null, PHOTOS));
    await run;
    expect(calls.map((argv) => argv[1])).toEqual(['preflight-create', 'dispatch-create']);
    expect(getPublishAllStatus().items[0]!.status).toBe('published');
  });

  it('names an unreadable photo set, not a missing one, when the refresh cannot fix it', async () => {
    arm();
    const saves: unknown[] = [];
    const calls: string[][] = [];
    const { run } = startPublishAllRun('test', withImages(dependencies({
      getCategoryAspects: noMissingAspects,
      runStep: async (argv) => {
        calls.push([...argv]);
        return { json: { status: 'denied', code: 'CREATE_REQUIRED_FIELD_MISSING', field: 'images' } };
      },
    }, saves, calls), 6));
    await run;
    // The refresh landed but preflight still refused: one refresh only, no loop.
    expect(saves).toHaveLength(1);
    expect(calls.map((argv) => argv[1])).toEqual(['preflight-create', 'preflight-create']);
    const item = getPublishAllStatus().items[0]!;
    expect(item.status).toBe('skipped');
    expect(item.reason).toContain('could not be read');
    expect(item.reason).not.toContain('does not have it yet');
  });
});

describe('publish-all eBay server error on create (incident #212)', () => {
  const noMissingAspects = async () => ({ available: true, aspects: [{ name: 'Brand', required: true }] });
  const serverError = { json: {
    command: 'dispatch-create', status: 'dispatch-failed-confirmed-missing',
    offerId: null, listingId: null, providerDispatchReported: false,
    dispatchFailureStage: 'put_inventory_item', dispatchFailureCode: 'CREATE_DISPATCH_WRITE_FAILED',
    dispatchFailureOutcomeClass: 'outcome_unknown', dispatchFailureHttpStatusFamily: 'http_5xx',
    dispatchFailureHttpStatusCode: 500, dispatchFailureEbayErrorIds: [25001],
    dispatchFailureEbayErrorMessages: ['A system error has occurred. Internal Server Error'],
  } };

  it('retries once from a refreshed draft after eBay\'s server error, then publishes', async () => {
    arm();
    const saves: unknown[] = [];
    const calls: string[][] = [];
    const { run } = startPublishAllRun('test', dependencies({
      getCategoryAspects: noMissingAspects,
      runStep: async (argv) => {
        calls.push([...argv]);
        if (argv[1] === 'preflight-create') return { json: { status: 'preview', manifestDigest: MANIFEST } };
        return argv.includes(REVISION)
          ? serverError
          : { json: { status: 'dispatched-and-reconciled', listingId: '147000000212' } };
      },
    }, saves, calls));
    await run;
    expect(saves).toHaveLength(1);
    expect(calls.map((argv) => argv[1])).toEqual([
      'preflight-create', 'dispatch-create', 'preflight-create', 'dispatch-create']);
    expect(calls[3]).toContain(SAVED);
    expect(getPublishAllStatus().items[0]).toMatchObject({ status: 'published', listingId: '147000000212' });
  });

  it('retries only once and names the stage, HTTP status and eBay error id when it persists', async () => {
    arm();
    const saves: unknown[] = [];
    const calls: string[][] = [];
    const { run } = startPublishAllRun('test', dependencies({
      getCategoryAspects: noMissingAspects,
      runStep: async (argv) => {
        calls.push([...argv]);
        if (argv[1] === 'preflight-create') return { json: { status: 'preview', manifestDigest: MANIFEST } };
        return serverError;
      },
    }, saves, calls));
    await run;
    expect(calls.filter((argv) => argv[1] === 'dispatch-create')).toHaveLength(2);
    const item = getPublishAllStatus().items[0]!;
    expect(item.status).toBe('failed');
    expect(item.reason).toBe('eBay refused the listing: A system error has occurred. Internal Server Error'
      + ' (put_inventory_item, HTTP 500, eBay error 25001; it retries next run)');
  });

  it('never retries while the failed create is still open on the ledger', async () => {
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
        return { json: { ...serverError.json, status: 'dispatched-unresolved' } };
      },
    }, saves, calls));
    await run;
    expect(saves).toHaveLength(0);
    expect(calls.map((argv) => argv[1])).toEqual(['preflight-create', 'dispatch-create']);
    expect(getPublishAllStatus().items[0]!.status).toBe('failed');
  });

  it('does not retry a payload refusal (HTTP 4xx)', async () => {
    arm();
    const saves: unknown[] = [];
    const calls: string[][] = [];
    const { run } = startPublishAllRun('test', dependencies({
      getCategoryAspects: noMissingAspects,
      runStep: async (argv) => {
        calls.push([...argv]);
        if (argv[1] === 'preflight-create') return { json: { status: 'preview', manifestDigest: MANIFEST } };
        return { json: { ...serverError.json, dispatchFailureHttpStatusFamily: 'http_4xx',
          dispatchFailureHttpStatusCode: 400, dispatchFailureEbayErrorIds: [25002],
          dispatchFailureEbayErrorMessages: ['A user error has occurred.'] } };
      },
    }, saves, calls));
    await run;
    expect(saves).toHaveLength(0);
    expect(calls.map((argv) => argv[1])).toEqual(['preflight-create', 'dispatch-create']);
    expect(getPublishAllStatus().items[0]!.reason).toBe('eBay refused the listing: A user error has occurred.');
  });

  it('refreshes a draft an earlier closed attempt used, instead of skipping it, then publishes', async () => {
    arm();
    const saves: unknown[] = [];
    const calls: string[][] = [];
    const { run } = startPublishAllRun('test', dependencies({
      getCategoryAspects: noMissingAspects,
      runStep: async (argv) => {
        calls.push([...argv]);
        if (argv[1] === 'preflight-create') return { json: { status: 'preview', manifestDigest: MANIFEST } };
        return argv.includes(REVISION)
          ? { json: { command: 'dispatch-create', status: 'denied', code: 'CREATE_INTENT_ALREADY_RECORDED' } }
          : { json: { status: 'dispatched-and-reconciled', listingId: '147000000213' } };
      },
    }, saves, calls));
    await run;
    expect(saves).toHaveLength(1);
    expect((saves[0] as { catalogId: string }).catalogId).toBe(CATALOG_ID);
    expect(calls.map((argv) => argv[1])).toEqual([
      'preflight-create', 'dispatch-create', 'preflight-create', 'dispatch-create']);
    expect(getPublishAllStatus().items[0]).toMatchObject({ status: 'published', listingId: '147000000213' });
  });

  it('keeps the replay skip when the earlier attempt is still open on the ledger', async () => {
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
        return { json: { command: 'dispatch-create', status: 'denied', code: 'CREATE_INTENT_ALREADY_RECORDED' } };
      },
    }, saves, calls));
    await run;
    expect(saves).toHaveLength(0);
    expect(calls.map((argv) => argv[1])).toEqual(['preflight-create', 'dispatch-create']);
    expect(getPublishAllStatus().items[0]!.status).toBe('skipped');
  });
});
