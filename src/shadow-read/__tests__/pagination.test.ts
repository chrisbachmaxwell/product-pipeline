import { describe, expect, it } from 'vitest';
import { ShadowReadError } from '../errors.js';
import {
  collectCompleteCursorPages,
  collectCompleteOffsetPages,
  type CursorPage,
  type OffsetPage,
} from '../pagination.js';

type RecordFixture = { id: string; state?: string; nested?: { value: string } };

const options = {
  caps: { maxPages: 3, maxRecords: 5 },
  expectedTotal: 3,
  stableId: (record: RecordFixture) => record.id,
} as const;

function cursorPages(): CursorPage<RecordFixture>[] {
  return [
    {
      requestCursor: null,
      nextCursor: 'cursor-page-2',
      records: [{ id: 'one' }, { id: 'two' }],
      pageComplete: true,
      reportedTotal: 3,
    },
    {
      requestCursor: 'cursor-page-2',
      nextCursor: null,
      records: [{ id: 'three' }],
      pageComplete: true,
      reportedTotal: 3,
    },
  ];
}

function offsetPages(): OffsetPage<RecordFixture>[] {
  return [
    {
      offset: 0,
      limit: 2,
      records: [{ id: 'one' }, { id: 'two' }],
      pageComplete: true,
      reportedTotal: 3,
    },
    {
      offset: 2,
      limit: 2,
      records: [{ id: 'three' }],
      pageComplete: true,
      reportedTotal: 3,
    },
  ];
}

function expectCode(action: () => unknown, code: ShadowReadError['code']): void {
  try {
    action();
    throw new Error('Expected pagination denial.');
  } catch (error) {
    expect(error).toBeInstanceOf(ShadowReadError);
    expect((error as ShadowReadError).code).toBe(code);
  }
}

describe('pure cursor pagination proof', () => {
  it('emits complete only after exact chain, terminal cursor, count, and stable-ID proof', () => {
    const result = collectCompleteCursorPages(cursorPages(), options);
    expect(result).toMatchObject({
      complete: true,
      pageCount: 2,
      recordCount: 3,
      reportedTotal: 3,
      fixtureOnly: true,
      liveProof: false,
    });
    expect(result.terminalCursorDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.datasetDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain('cursor-page-2');
  });

  it('deep-clones and freezes the proven records against later proof drift', () => {
    const pages = cursorPages();
    pages[0].records[0].nested = { value: 'before' };
    const result = collectCompleteCursorPages(pages, options);
    pages[0].records[0].nested!.value = 'after';
    expect(result.records[0]).toMatchObject({ nested: { value: 'before' } });
    expect(Object.isFrozen(result.records)).toBe(true);
    expect(Object.isFrozen(result.records[0])).toBe(true);
    expect(Object.isFrozen(result.records[0].nested)).toBe(true);
  });

  it('denies cursor loops and broken request-cursor sequence', () => {
    const selfLoop = cursorPages();
    selfLoop[1] = { ...selfLoop[1], nextCursor: 'cursor-page-2' };
    expectCode(() => collectCompleteCursorPages(selfLoop, options), 'pagination-denied');

    const brokenChain = cursorPages();
    brokenChain[1] = { ...brokenChain[1], requestCursor: 'unexpected-cursor' };
    expectCode(() => collectCompleteCursorPages(brokenChain, options), 'pagination-denied');
  });

  it('denies incomplete pages and an unconsumed terminal cursor', () => {
    const partialPage = cursorPages();
    partialPage[0] = { ...partialPage[0], pageComplete: false };
    expectCode(() => collectCompleteCursorPages(partialPage, options), 'pagination-denied');

    const unconsumed = cursorPages().slice(0, 1);
    expectCode(() => collectCompleteCursorPages(unconsumed, {
      ...options,
      expectedTotal: 2,
    }), 'pagination-denied');
  });

  it('denies duplicate stable IDs within or across pages', () => {
    const duplicate = cursorPages();
    duplicate[1] = { ...duplicate[1], records: [{ id: 'one' }] };
    expectCode(() => collectCompleteCursorPages(duplicate, options), 'pagination-denied');
  });

  it('denies page and record caps', () => {
    expectCode(() => collectCompleteCursorPages(cursorPages(), {
      ...options,
      caps: { maxPages: 1, maxRecords: 5 },
    }), 'page-cap-exceeded');
    expectCode(() => collectCompleteCursorPages(cursorPages(), {
      ...options,
      caps: { maxPages: 3, maxRecords: 2 },
    }), 'record-cap-exceeded');
  });

  it('denies inconsistent, source-mismatched, and expected totals', () => {
    const inconsistent = cursorPages();
    inconsistent[1] = { ...inconsistent[1], reportedTotal: 4 };
    expectCode(() => collectCompleteCursorPages(inconsistent, options), 'pagination-denied');

    const wrongSourceTotal = cursorPages().map((page) => ({ ...page, reportedTotal: 4 }));
    expectCode(() => collectCompleteCursorPages(wrongSourceTotal, {
      ...options,
      expectedTotal: null,
    }), 'pagination-denied');
    expectCode(() => collectCompleteCursorPages(cursorPages(), {
      ...options,
      expectedTotal: 4,
    }), 'pagination-denied');
  });

  it('denies unknown page fields and unsafe/duplicate selector output', () => {
    const unknown = cursorPages();
    unknown[0] = { ...unknown[0], unreviewed: true } as never;
    expectCode(() => collectCompleteCursorPages(unknown, options), 'pagination-denied');
    expectCode(() => collectCompleteCursorPages(cursorPages(), {
      ...options,
      stableId: () => '',
    }), 'pagination-denied');
    expectCode(() => collectCompleteCursorPages(cursorPages(), {
      ...options,
      stableId: () => { throw new Error('raw selector data'); },
    }), 'pagination-denied');
  });

  it('denies PII/secret-shaped records instead of emitting a complete proof', () => {
    const unsafe = cursorPages() as Array<CursorPage<Record<string, unknown>>>;
    unsafe[1] = {
      ...unsafe[1],
      records: [{ id: 'three', customerEmail: 'buyer@example.test' }],
    };
    expectCode(() => collectCompleteCursorPages(unsafe, {
      ...options,
      stableId: (record: Record<string, unknown>) => String(record.id),
    }), 'fixture-payload-denied');
  });
});

describe('pure offset pagination proof', () => {
  it('emits complete only for contiguous pages with a consistent exact total', () => {
    const result = collectCompleteOffsetPages(offsetPages(), options);
    expect(result).toMatchObject({
      complete: true,
      pageCount: 2,
      recordCount: 3,
      reportedTotal: 3,
      terminalCursorDigest: null,
      fixtureOnly: true,
      liveProof: false,
    });
    expect(result.datasetDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('denies offset gaps and short non-terminal pages', () => {
    const gap = offsetPages();
    gap[1] = { ...gap[1], offset: 3 };
    expectCode(() => collectCompleteOffsetPages(gap, options), 'pagination-denied');

    const short = offsetPages();
    short[0] = { ...short[0], records: [{ id: 'one' }] };
    short[1] = { ...short[1], offset: 1 };
    expectCode(() => collectCompleteOffsetPages(short, {
      ...options,
      expectedTotal: 2,
    }), 'pagination-denied');
  });

  it('denies duplicate IDs, inconsistent totals, and a missing final count', () => {
    const duplicate = offsetPages();
    duplicate[1] = { ...duplicate[1], records: [{ id: 'one' }] };
    expectCode(() => collectCompleteOffsetPages(duplicate, options), 'pagination-denied');

    const inconsistent = offsetPages();
    inconsistent[1] = { ...inconsistent[1], reportedTotal: 4 };
    expectCode(() => collectCompleteOffsetPages(inconsistent, options), 'pagination-denied');

    const missing = offsetPages().slice(0, 1);
    expectCode(() => collectCompleteOffsetPages(missing, options), 'pagination-denied');
  });

  it('denies caps, incomplete markers, and unknown fields', () => {
    expectCode(() => collectCompleteOffsetPages(offsetPages(), {
      ...options,
      caps: { maxPages: 1, maxRecords: 5 },
    }), 'page-cap-exceeded');

    const incomplete = offsetPages();
    incomplete[1] = { ...incomplete[1], pageComplete: false };
    expectCode(() => collectCompleteOffsetPages(incomplete, options), 'pagination-denied');

    const unknown = offsetPages();
    unknown[0] = { ...unknown[0], unknown: true } as never;
    expectCode(() => collectCompleteOffsetPages(unknown, options), 'pagination-denied');
  });
});
