import express, { type Request } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { writerQuarantineMiddleware } from '../../safety/writer-quarantine.js';
import type { ApiPrincipal } from '../middleware/auth.js';
import { listingDraftJsonParser, listingDraftJsonErrorHandler } from './listing-drafts.js';
import { createListingPublishRouter } from './listing-publish.js';

const CATALOG_ID = 'shopify-variant:gid://shopify/ProductVariant/55484011184419';
const REVISION = `sha256:${'b'.repeat(64)}`;
const MANIFEST = `sha256:${'c'.repeat(64)}`;
const PREFLIGHT = ['dist/listing-lifecycle-admin/index.js', 'preflight-create',
  '--catalog-id', '{catalogId}', '--sku', '{sku}', '--revision-digest', '{revisionDigest}'];
const DISPATCH = ['dist/listing-lifecycle-admin/index.js', 'dispatch-create',
  '--catalog-id', '{catalogId}', '--sku', '{sku}', '--revision-digest', '{revisionDigest}',
  '--manifest-digest', '{manifestDigest}', '--migration-store', '/data/x'];

const servers: Server[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

async function listen(app: express.Express): Promise<string> {
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function post(app: express.Express, path: string, body: unknown) {
  const base = await listen(app);
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
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
  app.post('/api/listing-publish', listingDraftJsonParser);
  app.use(listingDraftJsonErrorHandler);
  app.use(createListingPublishRouter({
    preflightArgv: options.armed === false ? null : PREFLIGHT,
    dispatchArgv: options.armed === false ? null : DISPATCH,
    runStep: async (argv) => {
      calls.push([...argv]);
      if (argv[1] === 'preflight-create') return { json: options.preflightJson ?? null };
      return { json: options.dispatchJson ?? null };
    },
  }));
  return { app, calls };
}

const validBody = { catalogId: CATALOG_ID, sku: '2882A001-U002', revisionDigest: REVISION };

describe('listing publish route', () => {
  it('publishes: preflight digest flows into dispatch, argv fully substituted', async () => {
    const h = harness({
      kind: 'shopify_session',
      preflightJson: { status: 'preview', manifestDigest: MANIFEST },
      dispatchJson: { status: 'created-and-reconciled', listingId: '147000000001', offerId: '9-1' },
    });
    const response = await post(h.app, '/api/listing-publish', validBody);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'created-and-reconciled', listingId: '147000000001' });
    expect(h.calls).toHaveLength(2);
    expect(h.calls[0]).toContain(CATALOG_ID);
    expect(h.calls[1]).toContain(MANIFEST);
    expect(h.calls[1].join(' ')).not.toContain('{');
  });

  it('refuses without an exact Shopify session — the click IS the approval', async () => {
    for (const kind of ['operator_api_key', 'test_mode'] as const) {
      const h = harness({ kind });
      const response = await post(h.app, '/api/listing-publish', validBody);
      expect(response.status).toBe(403);
      expect(h.calls).toHaveLength(0);
    }
  });

  it('refuses when the operator has not armed the publish argv', async () => {
    const h = harness({ kind: 'shopify_session', armed: false });
    const response = await post(h.app, '/api/listing-publish', validBody);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe('PUBLISH_NOT_ARMED');
  });

  it('rejects identifiers that fail the strict grammars before any spawn', async () => {
    const h = harness({ kind: 'shopify_session' });
    for (const body of [
      { ...validBody, catalogId: 'row-1; rm -rf /' },
      { ...validBody, revisionDigest: 'sha256:short' },
      { ...validBody, sku: 'bad sku with space ' },
      {},
    ]) {
      const response = await post(h.app, '/api/listing-publish', body);
      expect(response.status).toBe(400);
    }
    expect(h.calls).toHaveLength(0);
  });

  it('surfaces a preflight refusal with its ceremony code and never dispatches', async () => {
    const h = harness({
      kind: 'shopify_session',
      preflightJson: { status: 'denied', code: 'CREATE_REQUIRED_FIELD_MISSING' },
    });
    const response = await post(h.app, '/api/listing-publish', validBody);
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ code: 'CREATE_REQUIRED_FIELD_MISSING', stage: 'preflight' });
    expect(h.calls).toHaveLength(1);
  });

  it('other POST /api routes stay quarantined', async () => {
    const h = harness({ kind: 'shopify_session' });
    const response = await post(h.app, '/api/sync/trigger', {});
    expect(response.status).toBe(423);
  });
});
