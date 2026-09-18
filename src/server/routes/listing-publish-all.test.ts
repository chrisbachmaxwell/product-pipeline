import express, { type Request } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { writerQuarantineMiddleware } from '../../safety/writer-quarantine.js';
import type { ApiPrincipal } from '../middleware/auth.js';
import { listingDraftJsonParser, listingDraftJsonErrorHandler } from './listing-drafts.js';
import { createListingPublishAllRouter } from './listing-publish-all.js';
import { getPublishAllStatus, tryAcquirePublishLock, releasePublishLock } from '../publish-all.js';

const CATALOG_ID = 'shopify-variant:gid://shopify/ProductVariant/55484011184419';
const REVISION = `sha256:${'b'.repeat(64)}`;
const MANIFEST = `sha256:${'c'.repeat(64)}`;

const servers: Server[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

async function listen(app: express.Express): Promise<string> {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function principal(kind: ApiPrincipal['kind']): ApiPrincipal {
  return kind === 'shopify_session'
    ? { kind, actorId: 'shopify-user:123', subject: '123',
      shopifyStoreDomain: 'usedcameragear.myshopify.com' }
    : { kind, actorId: kind, subject: null, shopifyStoreDomain: null };
}

function harness(options: {
  kind: ApiPrincipal['kind'];
  armed?: boolean;
  preflightJson?: Record<string, unknown> | null;
  dispatchJson?: Record<string, unknown> | null;
}) {
  const calls: string[][] = [];
  const app = express();
  app.use((req, _res, next) => {
    (req as Request & { apiPrincipal?: ApiPrincipal }).apiPrincipal = principal(options.kind);
    next();
  });
  app.use('/api', writerQuarantineMiddleware);
  app.post('/api/listing-publish-all', listingDraftJsonParser);
  app.use(listingDraftJsonErrorHandler);
  app.use(createListingPublishAllRouter({
    armedCheck: () => options.armed !== false,
    getSnapshot: async () => ({ rows: [{
      id: CATALOG_ID,
      readyToList: true,
      shopify: { sku: '2882A001-U002', title: 'Canon Lens' },
    }] }),
    draftService: {
      get: async () => ({
        revision: { revisionDigest: REVISION },
        base: { sourceDigest: `sha256:${'d'.repeat(64)}`, ebayDigest: `sha256:${'e'.repeat(64)}` },
        sections: {
          listing: { title: { draft: null }, conditionDescription: { draft: null, shopify: null } },
          content: { itemSpecifics: { draft: null } },
        },
      }),
      save: async () => ({ revision: { revisionDigest: REVISION } }),
    },
    runStep: async (argv) => {
      calls.push([...argv]);
      if (argv[1] === 'preflight-create') {
        return { json: options.preflightJson ?? { status: 'preview', manifestDigest: MANIFEST } };
      }
      return { json: options.dispatchJson
        ?? { status: 'created-and-reconciled', listingId: '147000000001' } };
    },
    sleep: async () => undefined,
  }));
  return { app, calls };
}

async function request(app: express.Express, method: 'GET' | 'POST', body?: unknown) {
  const base = await listen(app);
  const response = await fetch(`${base}/api/listing-publish-all`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
}

async function waitForFinish(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (getPublishAllStatus().state !== 'running') return;
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
}

const PREFLIGHT_ENV = JSON.stringify(['dist/listing-lifecycle-admin/index.js', 'preflight-create',
  '--catalog-id', '{catalogId}', '--sku', '{sku}', '--revision-digest', '{revisionDigest}']);
const DISPATCH_ENV = JSON.stringify(['dist/listing-lifecycle-admin/index.js', 'dispatch-create',
  '--catalog-id', '{catalogId}', '--sku', '{sku}', '--revision-digest', '{revisionDigest}',
  '--manifest-digest', '{manifestDigest}', '--migration-store', '/data/x']);

function armEnv(): void {
  process.env.PUBLISH_PREFLIGHT_ARGV = PREFLIGHT_ENV;
  process.env.PUBLISH_DISPATCH_ARGV = DISPATCH_ENV;
}

afterEach(() => {
  delete process.env.PUBLISH_PREFLIGHT_ARGV;
  delete process.env.PUBLISH_DISPATCH_ARGV;
  releasePublishLock();
});

describe('listing publish-all route', () => {
  it('starts a run, publishes each ready item through the ceremonies, reports progress', async () => {
    armEnv();
    const h = harness({ kind: 'shopify_session' });
    const started = await request(h.app, 'POST', {});
    expect(started.status).toBe(202);
    await waitForFinish();
    const status = getPublishAllStatus();
    expect(status.state).toBe('finished');
    expect(status.items).toEqual([expect.objectContaining({
      sku: '2882A001-U002', status: 'published', listingId: '147000000001',
    })]);
    expect(h.calls.map((call) => call[1])).toEqual(['preflight-create', 'dispatch-create']);
    expect(h.calls[1].join(' ')).toContain(MANIFEST);
    expect(h.calls[1].join(' ')).not.toContain('{');
  });

  it('requires the exact Shopify session for both GET and POST', async () => {
    armEnv();
    const h = harness({ kind: 'operator_api_key' });
    expect((await request(h.app, 'POST', {})).status).toBe(403);
    expect((await request(h.app, 'GET')).status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  it('refuses when publish argv is not armed', async () => {
    const h = harness({ kind: 'shopify_session', armed: false });
    const response = await request(h.app, 'POST', {});
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('PUBLISH_NOT_ARMED');
  });

  it('refuses while another publish holds the shared lock', async () => {
    armEnv();
    expect(tryAcquirePublishLock()).toBe(true);
    const h = harness({ kind: 'shopify_session' });
    const response = await request(h.app, 'POST', {});
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('PUBLISH_BUSY');
    expect(h.calls).toHaveLength(0);
  });

  it('records a skip with a plain-language reason for a required-field refusal', async () => {
    armEnv();
    const h = harness({
      kind: 'shopify_session',
      preflightJson: { status: 'denied', code: 'CREATE_REQUIRED_FIELD_MISSING', field: 'condition' },
    });
    const started = await request(h.app, 'POST', {});
    expect(started.status).toBe(202);
    await waitForFinish();
    const status = getPublishAllStatus();
    expect(status.state).toBe('finished');
    expect(status.items[0]).toMatchObject({ status: 'skipped' });
    expect(status.items[0]!.reason).toContain('condition');
  });
});
