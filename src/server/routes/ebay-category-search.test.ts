import http from 'node:http';
import express from 'express';
import { describe, expect, it } from 'vitest';
import type { Router } from 'express';
import { createShadowApiRouter, SHADOW_API_GET_PATHS } from './shadow-api.js';
import {
  createEbayCategorySearch,
  EbayCategorySearchError,
  EBAY_CATEGORY_SEARCH_TESTING,
  validateEbayCategoryQuery,
} from '../ebay-category-search.js';

const ENDPOINT = '/api/ebay-category-search';
const TREE_URL = 'https://api.ebay.com/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=EBAY_US';
const SUGGESTIONS_PREFIX = 'https://api.ebay.com/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=';

type RecordedCall = { url: string; init: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function suggestionsBody(): Record<string, unknown> {
  return {
    categorySuggestions: [
      {
        category: { categoryId: '30088', categoryName: 'Other Lighting & Studio' },
        categoryTreeNodeLevel: 4,
        // Most-specific-first, as the Taxonomy API returns them.
        categoryTreeNodeAncestors: [
          { categoryId: '30078', categoryName: 'Lighting & Studio', categoryTreeNodeLevel: 3 },
          { categoryId: '625', categoryName: 'Cameras & Photo', categoryTreeNodeLevel: 2 },
          { categoryId: '293', categoryName: 'Electronics', categoryTreeNodeLevel: 1 },
        ],
        leafCategoryTreeNode: true,
      },
      {
        category: { categoryId: 11724, categoryName: 'Film Cameras' },
        categoryTreeNodeAncestors: [
          { categoryId: '625', categoryName: 'Cameras & Photo' },
        ],
      },
      // Malformed entries of every kind are dropped, never escaped, never fatal.
      'not-a-record',
      { category: { categoryId: 'not-digits', categoryName: 'Bad Id' } },
      { category: { categoryId: '1', categoryName: 'bad\u0000name' } },
      { category: { categoryId: '2', categoryName: 'x'.repeat(257) } },
      { category: { categoryId: '3', categoryName: 'Deep' },
        categoryTreeNodeAncestors: Array.from({ length: 11 }, (_v, i) => (
          { categoryId: String(i), categoryName: `Level ${i}` })) },
      { category: { categoryId: '4', categoryName: 'Bad Ancestor' },
        categoryTreeNodeAncestors: [{ categoryName: 'ok\u001Fbad' }] },
      { category: { categoryId: '5', categoryName: 'Bad Leaf' }, leafCategoryTreeNode: 'yes' },
    ],
  };
}

function fakeFetch(
  calls: RecordedCall[],
  respond: (url: string) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return respond(url);
  }) as typeof fetch;
}

function standardRespond(url: string): Response {
  if (url === TREE_URL) return jsonResponse({ categoryTreeId: '0', categoryTreeVersion: '129' });
  if (url.startsWith(SUGGESTIONS_PREFIX)) return jsonResponse(suggestionsBody());
  throw new Error(`unexpected url ${url}`);
}

function createSearch(options: Readonly<{
  calls?: RecordedCall[];
  respond?: (url: string) => Response | Promise<Response>;
  getAccessToken?: () => Promise<string>;
  now?: () => number;
}> = {}) {
  return createEbayCategorySearch({
    getAccessToken: options.getAccessToken ?? (async () => 'transient-token'),
    fetchImpl: fakeFetch(options.calls ?? [], options.respond ?? standardRespond),
    now: options.now,
  });
}

async function requestJson(router: Router, pathname: string): Promise<{
  status: number;
  body: Record<string, any>;
}> {
  const app = express();
  app.use(router);
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server address unavailable');
    return await new Promise((resolve, reject) => {
      const request = http.get(
        { hostname: '127.0.0.1', port: address.port, path: pathname },
        (response) => {
          let raw = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => { raw += chunk; });
          response.on('end', () => {
            try {
              resolve({
                status: response.statusCode ?? 0,
                body: JSON.parse(raw) as Record<string, any>,
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on('error', reject);
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (!error || (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') resolve();
        else reject(error);
      });
    });
  }
}

describe('eBay category suggestion search', () => {
  it('is registered on the shadow API GET allowlist', () => {
    expect(SHADOW_API_GET_PATHS).toContain(ENDPOINT);
  });

  it('fetches the tree id once, then maps suggestions to the bounded DTO', async () => {
    const calls: RecordedCall[] = [];
    const search = createSearch({ calls });

    const first = await search('studio light');
    expect(first).toEqual({
      categories: [
        {
          id: '30088',
          name: 'Other Lighting & Studio',
          path: 'Electronics > Cameras & Photo > Lighting & Studio > Other Lighting & Studio',
          leaf: true,
        },
        {
          id: '11724',
          name: 'Film Cameras',
          path: 'Cameras & Photo > Film Cameras',
          leaf: true,
        },
      ],
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.categories)).toBe(true);

    // A second, different query re-uses the forever-cached tree id.
    await search('film camera');
    const treeCalls = calls.filter((call) => call.url === TREE_URL);
    const suggestionCalls = calls.filter((call) => call.url.startsWith(SUGGESTIONS_PREFIX));
    expect(treeCalls).toHaveLength(1);
    expect(suggestionCalls).toHaveLength(2);
    expect(suggestionCalls[0]!.url).toBe(`${SUGGESTIONS_PREFIX}studio%20light`);
    for (const call of calls) {
      expect(call.init.method).toBe('GET');
      expect(call.init.redirect).toBe('error');
    }
  });

  it('caps results at 25 entries', async () => {
    const search = createSearch({
      respond: (url) => url === TREE_URL
        ? jsonResponse({ categoryTreeId: '0' })
        : jsonResponse({
          categorySuggestions: Array.from({ length: 40 }, (_value, index) => ({
            category: { categoryId: String(1000 + index), categoryName: `Category ${index}` },
          })),
        }),
    });
    const dto = await search('camera');
    expect(EBAY_CATEGORY_SEARCH_TESTING.MAX_SUGGESTIONS).toBe(25);
    expect(dto.categories).toHaveLength(25);
  });

  it('returns empty categories for no matches', async () => {
    const search = createSearch({
      respond: (url) => url === TREE_URL
        ? jsonResponse({ categoryTreeId: '0' })
        : jsonResponse({}),
    });
    await expect(search('zzzz')).resolves.toEqual({ categories: [] });
  });

  it('serves repeat queries from the normalized-q cache with no second upstream call', async () => {
    const calls: RecordedCall[] = [];
    const search = createSearch({ calls });
    const first = await search('Studio Light');
    const second = await search('  studio light  ');
    expect(second).toEqual(first);
    expect(calls.filter((call) => call.url.startsWith(SUGGESTIONS_PREFIX))).toHaveLength(1);
  });

  it('expires cached queries after one hour', async () => {
    let epoch = 1_000_000;
    const calls: RecordedCall[] = [];
    const search = createSearch({ calls, now: () => epoch });
    await search('studio light');
    epoch += EBAY_CATEGORY_SEARCH_TESTING.QUERY_CACHE_TTL_MS - 1;
    await search('studio light');
    expect(calls.filter((call) => call.url.startsWith(SUGGESTIONS_PREFIX))).toHaveLength(1);
    epoch += 2;
    await search('studio light');
    expect(calls.filter((call) => call.url.startsWith(SUGGESTIONS_PREFIX))).toHaveLength(2);
  });

  it('evicts the least recently used query beyond 500 cached entries', async () => {
    const calls: RecordedCall[] = [];
    const search = createSearch({
      calls,
      respond: (url) => url === TREE_URL
        ? jsonResponse({ categoryTreeId: '0' })
        : jsonResponse({ categorySuggestions: [] }),
    });
    expect(EBAY_CATEGORY_SEARCH_TESTING.MAX_CACHED_QUERIES).toBe(500);
    for (let index = 0; index < 501; index += 1) {
      await search(`query ${index}`);
    }
    const before = calls.filter((call) => call.url.startsWith(SUGGESTIONS_PREFIX)).length;
    await search('query 0'); // evicted: refetches
    await search('query 500'); // still cached: no refetch
    const after = calls.filter((call) => call.url.startsWith(SUGGESTIONS_PREFIX)).length;
    expect(after).toBe(before + 1);
  });

  it('coalesces concurrent lookups for one normalized query into one upstream call', async () => {
    const calls: RecordedCall[] = [];
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const search = createSearch({
      calls,
      respond: async (url) => {
        if (url === TREE_URL) return jsonResponse({ categoryTreeId: '0' });
        await gate;
        return jsonResponse(suggestionsBody());
      },
    });
    const [first, second] = [search('studio light'), search('STUDIO LIGHT')];
    await new Promise((resolve) => setTimeout(resolve, 10));
    release!();
    const [firstDto, secondDto] = await Promise.all([first, second]);
    expect(secondDto).toEqual(firstDto);
    expect(calls.filter((call) => call.url.startsWith(SUGGESTIONS_PREFIX))).toHaveLength(1);
  });

  it.each([
    ['non-string', 42],
    ['empty', ''],
    ['one character after trim', ' a '],
    ['101 characters', 'x'.repeat(101)],
    ['control character', 'ab\u0000cd'],
    ['line separator', 'ab\u2028cd'],
  ])('rejects invalid query (%s) without any upstream call', async (_label, query) => {
    const calls: RecordedCall[] = [];
    const search = createSearch({ calls });
    await expect(search(query)).rejects.toMatchObject({
      name: 'EbayCategorySearchError',
      code: 'INVALID_QUERY',
    });
    expect(calls).toHaveLength(0);
    expect(() => validateEbayCategoryQuery(query)).toThrow(EbayCategorySearchError);
  });

  it('accepts a trimmed 2..100 character query', () => {
    expect(validateEbayCategoryQuery('  tv  ')).toBe('tv');
    expect(validateEbayCategoryQuery('x'.repeat(100))).toBe('x'.repeat(100));
  });

  it.each([
    ['upstream 500', () => jsonResponse({ error: 'secret upstream detail' }, 500)],
    ['non-JSON body', () => new Response('<html>oops</html>', { status: 200 })],
    ['oversized body', () => new Response(
      `{"pad":"${'x'.repeat(EBAY_CATEGORY_SEARCH_TESTING.MAX_RESPONSE_BYTES)}"}`,
      { status: 200 },
    )],
  ])('redacts %s to a fixed failure code', async (_label, respond) => {
    const search = createSearch({
      respond: (url) => url === TREE_URL ? jsonResponse({ categoryTreeId: '0' }) : respond(),
    });
    const failure = await search('studio light').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EbayCategorySearchError);
    expect((failure as EbayCategorySearchError).message).toBe('eBay category search is unavailable');
    expect(JSON.stringify({ ...(failure as Error) })).not.toMatch(/secret|upstream detail|Bearer/);
  });

  it('fails closed when the token provider fails, without leaking it', async () => {
    const search = createSearch({
      getAccessToken: async () => { throw new Error('Bearer secret-token-value'); },
    });
    await expect(search('studio light')).rejects.toMatchObject({
      code: 'AUTHORITY_UNAVAILABLE',
      message: 'eBay category search is unavailable',
    });
  });

  it('does not cache failed lookups', async () => {
    const calls: RecordedCall[] = [];
    let failNext = true;
    const search = createSearch({
      calls,
      respond: (url) => {
        if (url === TREE_URL) return jsonResponse({ categoryTreeId: '0' });
        if (failNext) {
          failNext = false;
          return jsonResponse({}, 503);
        }
        return jsonResponse(suggestionsBody());
      },
    });
    await expect(search('studio light')).rejects.toBeInstanceOf(EbayCategorySearchError);
    await expect(search('studio light')).resolves.toMatchObject({
      categories: expect.arrayContaining([expect.objectContaining({ id: '30088' })]),
    });
    expect(calls.filter((call) => call.url.startsWith(SUGGESTIONS_PREFIX))).toHaveLength(2);
  });

  it('serves the DTO through the shadow route with no-store semantics', async () => {
    const search = createSearch({});
    const router = createShadowApiRouter({
      getSnapshot: async () => { throw new Error('unused'); },
      searchEbayCategories: search,
    });
    const response = await requestJson(router, `${ENDPOINT}?q=studio%20light`);
    expect(response.status).toBe(200);
    expect(Object.keys(response.body)).toEqual(['categories']);
    expect(response.body.categories[0]).toEqual({
      id: '30088',
      name: 'Other Lighting & Studio',
      path: 'Electronics > Cameras & Photo > Lighting & Studio > Other Lighting & Studio',
      leaf: true,
    });
  });

  it('maps invalid queries to 400 and every other failure to one generic 503', async () => {
    const router = createShadowApiRouter({
      getSnapshot: async () => { throw new Error('unused'); },
      searchEbayCategories: createSearch({
        respond: () => jsonResponse({ error: 'Bearer secret-value' }, 500),
      }),
    });
    const missing = await requestJson(router, ENDPOINT);
    expect(missing).toEqual({ status: 400, body: { error: 'Invalid category search query' } });
    const short = await requestJson(router, `${ENDPOINT}?q=a`);
    expect(short).toEqual({ status: 400, body: { error: 'Invalid category search query' } });

    const failed = await requestJson(router, `${ENDPOINT}?q=studio%20light`);
    expect(failed).toEqual({ status: 503, body: { error: 'Category search is unavailable' } });
    expect(JSON.stringify(failed)).not.toMatch(/secret-value|Bearer/);
  });
});

describe('eBay category browse route', () => {
  const BROWSE_ENDPOINT = '/api/ebay-category-browse';

  it('is registered on the shadow API GET allowlist', () => {
    expect(SHADOW_API_GET_PATHS).toContain(BROWSE_ENDPOINT);
  });

  it('serves one browse level through the shadow route', async () => {
    const router = createShadowApiRouter({
      getSnapshot: async () => { throw new Error('unused'); },
      browseEbayCategories: async (parentId) => ({
        parentId: typeof parentId === 'string' && parentId !== '' ? parentId : null,
        breadcrumb: Object.freeze([Object.freeze({ id: '625', name: 'Cameras & Photo' })]),
        children: Object.freeze([
          Object.freeze({ id: '30086', name: 'Slaves & Trigger Systems', leaf: true, childCount: 0 }),
        ]),
      }),
    });
    const response = await requestJson(router, `${BROWSE_ENDPOINT}?parent=30090`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      parentId: '30090',
      breadcrumb: [{ id: '625', name: 'Cameras & Photo' }],
      children: [{ id: '30086', name: 'Slaves & Trigger Systems', leaf: true, childCount: 0 }],
    });
  });

  it('maps a bad id to 400 and every other failure to one generic 503', async () => {
    const router = createShadowApiRouter({
      getSnapshot: async () => { throw new Error('unused'); },
      browseEbayCategories: async (parentId) => {
        if (parentId === 'bogus') throw new EbayCategorySearchError('INVALID_QUERY');
        throw new EbayCategorySearchError('REMOTE_READ_FAILED');
      },
    });
    const invalid = await requestJson(router, `${BROWSE_ENDPOINT}?parent=bogus`);
    expect(invalid).toEqual({ status: 400, body: { error: 'Invalid category id' } });

    const failed = await requestJson(router, `${BROWSE_ENDPOINT}?parent=30090`);
    expect(failed).toEqual({ status: 503, body: { error: 'Category browse is unavailable' } });
  });
});
