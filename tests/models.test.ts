import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { Vault } from '../src/crypto.js';
import { Store } from '../src/store.js';
import { DEFAULT_CONTEXT_WINDOW, resolvedContextWindow } from '../src/models.js';
import { createServer } from '../src/server.js';
import { MockUpstream, bundledCatalog, catalogPayload, fixture, testEnv } from './helpers.js';

function storeFixture(t: { after: (fn: () => void) => void }) {
  const dataDir = mkdtempSync(join(tmpdir(), 'wkbdy-models-'));
  const db = openDatabase(dataDir);
  const store = new Store(db, new Vault(dataDir));
  t.after(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { store, dataDir };
}

test('context window resolution prefers the request, then the panel, then the 1M default', (t) => {
  const { store } = storeFixture(t);
  const catalog = bundledCatalog();
  const model = catalog.models.find(
    (entry) => (entry.x_workbuddy.context_window?.supportedLengths.length ?? 0) > 1,
  );
  assert.ok(model, 'bundled catalog needs a model with several context lengths');
  const plain = catalog.models.find((entry) => !entry.x_workbuddy.context_window);
  assert.ok(plain, 'bundled catalog needs a model without context lengths');
  const lengths = [...model.x_workbuddy.context_window!.supportedLengths].sort((a, b) => a - b);
  store.importCatalog(catalog);

  const stored = store.model(model.id)!;
  assert.equal(resolvedContextWindow(stored), DEFAULT_CONTEXT_WINDOW);
  assert.equal(resolvedContextWindow(store.model(plain.id)!), DEFAULT_CONTEXT_WINDOW);

  // Client values are passed through as-is, even outside the catalog lengths.
  assert.equal(resolvedContextWindow(stored, lengths[0]), lengths[0]);
  assert.equal(resolvedContextWindow(stored, 1_234_567), 1_234_567);
  assert.equal(resolvedContextWindow(store.model(plain.id)!, 250_000), 250_000);

  store.patchModel(model.id, { context_window: lengths[0] });
  assert.equal(resolvedContextWindow(store.model(model.id)!), lengths[0]);
  assert.equal(resolvedContextWindow(store.model(model.id)!, 900_000), 900_000);
  store.patchModel(model.id, { context_window: null });
  assert.equal(resolvedContextWindow(store.model(model.id)!), DEFAULT_CONTEXT_WINDOW);
});

test('a panel sync pulls the product catalog from the upstream', async (t) => {
  const context = await fixture(t, { catalog: false });
  assert.deepEqual(context.store.models(), [], 'the model table starts empty');
  context.upstream.catalog = catalogPayload([
    { id: 'model-a', supportedLengths: [200000, 400000] },
    { id: 'model-b' },
  ]);

  const synced = await context.app.inject({
    method: 'POST',
    url: '/api/admin/models/sync',
    headers: context.headers,
  });
  assert.equal(synced.statusCode, 200);
  const body = synced.json<{ added: number; updated: number; removed: number; catalog_url: string }>();
  assert.deepEqual(
    { added: body.added, updated: body.updated, removed: body.removed },
    { added: 2, updated: 0, removed: 0 },
  );
  assert.equal(body.catalog_url, 'https://www.workbuddy.ai/v3/config');
  assert.deepEqual(
    context.store
      .models()
      .map((model) => model.id)
      .sort(),
    ['model-a', 'model-b'],
  );
  assert.deepEqual(context.store.model('model-a')!.x_workbuddy.context_window, {
    defaultLength: 200000,
    supportedLengths: [200000, 400000],
  });
  assert.ok(context.store.meta<string>('catalogSyncedAt'));

  // The catalog endpoint sits next to the chat endpoint and needs the account.
  const call = context.upstream.calls.find((entry) => entry.url.endsWith('/v3/config'))!;
  assert.equal(call.headers.get('authorization'), 'Bearer test-access-token-value');
  assert.equal(call.headers.get('x-user-id'), 'user-1');
  assert.equal(call.headers.get('x-domain'), 'www.workbuddy.ai');
  assert.equal(call.headers.get('x-product'), 'SaaS');
  assert.equal(call.headers.get('user-agent'), 'WorkBuddy/2.137.1');
});

test('a rejected catalog leaves the stored models untouched', async (t) => {
  const context = await fixture(t, { catalog: false });
  context.upstream.catalog = catalogPayload([{ id: 'alpha' }, { id: 'beta' }]);
  const synced = await context.app.inject({
    method: 'POST',
    url: '/api/admin/models/sync',
    headers: context.headers,
  });
  assert.equal(synced.statusCode, 200);
  const stored = () =>
    context.store
      .models()
      .map((model) => model.id)
      .sort();
  assert.deepEqual(stored(), ['alpha', 'beta']);

  // A dangling agent reference must not half-import: the client catalog would
  // silently lose the model the agent points at.
  context.upstream.catalog = {
    data: { models: [{ id: 'alpha' }], agents: [{ name: 'cli', models: ['ghost'] }] },
  };
  const invalid = await context.app.inject({
    method: 'POST',
    url: '/api/admin/models/sync',
    headers: context.headers,
  });
  assert.equal(invalid.statusCode, 502);
  assert.equal(invalid.json<{ error: { code: string } }>().error.code, 'catalog_invalid');
  assert.deepEqual(stored(), ['alpha', 'beta']);

  // A payload without models at all is rejected the same way.
  context.upstream.catalog = { data: { models: [], agents: [{ name: 'cli', models: [] }] } };
  const empty = await context.app.inject({
    method: 'POST',
    url: '/api/admin/models/sync',
    headers: context.headers,
  });
  assert.equal(empty.statusCode, 502);
  assert.deepEqual(stored(), ['alpha', 'beta'], 'an empty payload never wipes the catalog');
});

test('a credential the upstream refuses is reported as an account problem', async (t) => {
  const context = await fixture(t, { catalog: false });
  context.upstream.catalogStatus = 401;
  const refused = await context.app.inject({
    method: 'POST',
    url: '/api/admin/models/sync',
    headers: context.headers,
  });
  assert.equal(refused.statusCode, 502);
  assert.equal(refused.json<{ error: { code: string } }>().error.code, 'catalog_unauthorized');
  assert.equal(context.store.accounts()[0]!.needsReauth, true, 'the account is flagged for a new login');
});

test('a sync without any usable account reports an empty pool', async (t) => {
  const context = await fixture(t, { catalog: false, account: false });
  const synced = await context.app.inject({
    method: 'POST',
    url: '/api/admin/models/sync',
    headers: context.headers,
  });
  assert.equal(synced.statusCode, 503);
  assert.equal(synced.json<{ error: { code: string } }>().error.code, 'no_available_account');
});

test('an unreachable catalog endpoint fails the sync without clearing the models', async (t) => {
  const upstream = new MockUpstream();
  upstream.catalogStatus = 502;
  const context = await fixture(t, { upstream, catalog: false });
  context.upstream.catalog = catalogPayload([{ id: 'alpha' }]);
  assert.equal(
    (await context.app.inject({ method: 'POST', url: '/api/admin/models/sync', headers: context.headers }))
      .statusCode,
    502,
  );

  context.upstream.catalogError = new Error('fetch failed');
  const offline = await context.app.inject({
    method: 'POST',
    url: '/api/admin/models/sync',
    headers: context.headers,
  });
  assert.equal(offline.statusCode, 502);
  assert.equal(offline.json<{ error: { code: string } }>().error.code, 'catalog_unreachable');
  assert.deepEqual(context.store.models(), [], 'a failed sync never writes a partial catalog');
});

test('the model listing and detail routes only expose enabled models', async (t) => {
  const context = await fixture(t);
  const listed = await context.app.inject({ method: 'GET', url: '/v1/models', headers: context.apiHeaders });
  assert.equal(listed.statusCode, 200);
  const ids = listed.json<{ data: Array<{ id: string }> }>().data.map((model) => model.id);
  assert.ok(ids.length > 0);
  const firstId = ids[0]!;
  assert.equal(
    (await context.app.inject({ method: 'GET', url: `/v1/models/${firstId}`, headers: context.apiHeaders }))
      .statusCode,
    200,
  );

  context.store.patchModel(firstId, { enabled: false });
  const afterDisable = await context.app.inject({
    method: 'GET',
    url: '/v1/models',
    headers: context.apiHeaders,
  });
  const remaining = afterDisable.json<{ data: Array<{ id: string }> }>().data.map((model) => model.id);
  assert.ok(!remaining.includes(firstId));
  assert.equal(
    (await context.app.inject({ method: 'GET', url: `/v1/models/${firstId}`, headers: context.apiHeaders }))
      .statusCode,
    404,
  );

  const missing = await context.app.inject({
    method: 'GET',
    url: '/v1/models/nope',
    headers: context.apiHeaders,
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json<{ error: { code: string } }>().error.code, 'model_not_found');
});

test('a first boot with an account pulls the catalog from the upstream', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wkbdy-boot-'));
  const seed = openDatabase(dataDir);
  new Store(seed, new Vault(dataDir)).upsertAccount({
    name: 'boot account',
    note: '',
    source: 'manual',
    accessToken: 'boot-token-value',
    refreshToken: '',
    userId: 'boot-user',
    domain: 'www.workbuddy.ai',
  });
  seed.close();

  const upstream = new MockUpstream();
  upstream.catalog = catalogPayload([{ id: 'boot-model' }]);
  const context = await createServer({ env: testEnv({ dataDir }), fetcher: upstream.fetch, jobs: false });
  t.after(async () => {
    await context.app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  assert.deepEqual(
    context.store.models().map((model) => model.id),
    ['boot-model'],
    'a fresh install seeds itself from the product catalog',
  );
});

test('a first boot without accounts still starts and serves an empty catalog', async (t) => {
  const env = testEnv();
  const context = await createServer({ env, fetcher: new MockUpstream().fetch, jobs: false });
  t.after(async () => {
    await context.app.close();
    rmSync(env.dataDir, { recursive: true, force: true });
  });
  assert.deepEqual(context.store.models(), []);
  assert.equal((await context.app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
});
