import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { Vault } from '../src/crypto.js';
import { Store } from '../src/store.js';
import { DEFAULT_CONTEXT_WINDOW, resolvedContextWindow } from '../src/models.js';
import { syncCatalog } from '../src/routes/admin.js';
import { bundledCatalog, fixture, writeCatalog } from './helpers.js';

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

test('catalog sync reads a product config file and records the sync time', async (t) => {
  const { store, dataDir } = storeFixture(t);
  const catalogPath = join(dataDir, 'catalog.json');
  writeFileSync(
    catalogPath,
    JSON.stringify({
      data: {
        models: [
          {
            id: 'model-a',
            name: 'Model A',
            isDefault: true,
            supportsToolCall: true,
            maxOutputTokens: 4096,
            contextWindow: { defaultLength: 200000, supportedLengths: [200000, 400000] },
          },
        ],
        agents: [{ name: 'cli', models: ['model-a'] }],
      },
    }),
  );
  const summary = await syncCatalog(catalogPath, store);
  assert.deepEqual({ added: summary.added, updated: summary.updated }, { added: 1, updated: 0 });
  assert.equal(store.model('model-a')!.x_workbuddy.max_output_tokens, 4096);
  assert.ok(store.meta<string>('catalogSyncedAt'));

  await assert.rejects(
    () => syncCatalog(join(dataDir, 'missing.json'), store),
    /Cannot read the catalog file/,
  );

  writeFileSync(
    catalogPath,
    JSON.stringify({ data: { models: [{ id: 'model-a' }], agents: [{ name: 'cli', models: ['model-b'] }] } }),
  );
  await assert.rejects(() => syncCatalog(catalogPath, store), /references unknown model/);
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

test('the catalog file is the import source for /api/admin/models/sync', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wkbdy-catalog-'));
  const catalogPath = join(dataDir, 'catalog.json');
  writeCatalog(catalogPath, [{ id: 'alpha', supportedLengths: [1000, 2000] }, { id: 'beta' }]);
  const context = await fixture(t, { env: { catalogPath } });
  assert.deepEqual(
    context.store
      .models()
      .map((model) => model.id)
      .sort(),
    ['alpha', 'beta'],
    'a fresh install bootstraps its catalog from the configured file',
  );

  writeCatalog(catalogPath, [{ id: 'alpha', supportedLengths: [1000, 2000] }, { id: 'gamma' }]);
  const synced = await context.app.inject({
    method: 'POST',
    url: '/api/admin/models/sync',
    headers: context.headers,
  });
  assert.equal(synced.statusCode, 200);
  assert.deepEqual(synced.json<{ added: number; updated: number; removed: number }>().added, 1);
  assert.deepEqual(
    context.store
      .models()
      .map((model) => model.id)
      .sort(),
    ['alpha', 'gamma'],
  );
  assert.equal(context.store.model('beta'), undefined);
  rmSync(dataDir, { recursive: true, force: true });
});
