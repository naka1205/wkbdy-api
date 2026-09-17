import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { Vault } from '../src/crypto.js';
import { Store } from '../src/store.js';
import { bundledCatalog } from './helpers.js';

function storeFixture(t: { after: (fn: () => void) => void }, encryptionKey?: string) {
  const dataDir = mkdtempSync(join(tmpdir(), 'wkbdy-store-'));
  const db = openDatabase(dataDir);
  const store = new Store(db, new Vault(dataDir, encryptionKey));
  t.after(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { store, dataDir, db };
}

test('accounts are encrypted at rest and deduplicated by upstream identity', (t) => {
  const { store, db } = storeFixture(t);
  const created = store.upsertAccount({
    name: '',
    note: 'first',
    source: 'manual',
    accessToken: 'token-one',
    refreshToken: 'refresh-one',
    userId: 'user-1',
    domain: 'www.workbuddy.ai',
  });
  assert.equal(created.source, 'manual');
  assert.equal(created.hasRefreshToken, true);
  const raw = db.prepare('SELECT access_token FROM accounts WHERE id=?').get(created.id) as {
    access_token: string;
  };
  assert.ok(!raw.access_token.includes('token-one'), 'token must not be stored in clear text');

  const updated = store.upsertAccount({
    name: 'renamed',
    note: '',
    source: 'oauth',
    accessToken: 'token-two',
    refreshToken: 'refresh-two',
    userId: 'user-1',
    domain: 'www.workbuddy.ai',
  });
  assert.equal(updated.id, created.id, 'same upstream user must update the existing row');
  assert.equal(updated.name, 'renamed');
  assert.equal(store.accounts().length, 1);
  assert.equal(store.credential(created.id)?.accessToken, 'token-two');
  assert.equal(updated.email, null, 'a token without an email claim stores no address');

  store.setAccountEmail(created.id, 'user-1@example.com');
  assert.equal(store.account(created.id)?.email, 'user-1@example.com');
  store.setAccountEmail(created.id, null);
  assert.equal(store.account(created.id)?.email, 'user-1@example.com', 'empty backfills are ignored');
});

test('an account address from the token is stored and updated', (t) => {
  const { store } = storeFixture(t);
  const first = store.upsertAccount({
    name: '',
    note: '',
    source: 'oauth',
    accessToken: 'token-one',
    refreshToken: '',
    userId: 'user-1',
    domain: 'www.workbuddy.ai',
    email: 'one@example.com',
  });
  assert.equal(first.email, 'one@example.com');
  const second = store.upsertAccount({
    name: '',
    note: '',
    source: 'oauth',
    accessToken: 'token-two',
    refreshToken: '',
    userId: 'user-1',
    domain: 'www.workbuddy.ai',
  });
  assert.equal(second.id, first.id);
  assert.equal(second.email, 'one@example.com', 'a token without an email keeps the known address');
});

test('a different account is added as a separate row', (t) => {
  const { store } = storeFixture(t);
  store.upsertAccount({
    name: '',
    note: '',
    source: 'manual',
    accessToken: 'a',
    refreshToken: '',
    userId: 'u1',
    domain: 'www.workbuddy.ai',
  });
  store.upsertAccount({
    name: '',
    note: '',
    source: 'manual',
    accessToken: 'b',
    refreshToken: '',
    userId: 'u2',
    domain: 'www.workbuddy.ai',
  });
  assert.equal(store.accounts().length, 2);
});

test('transient failures only pause an account after the strike count', (t) => {
  const { store } = storeFixture(t);
  const account = store.upsertAccount({
    name: '',
    note: '',
    source: 'manual',
    accessToken: 'transient-token',
    refreshToken: '',
    userId: 'user-transient',
    domain: 'www.workbuddy.ai',
  });
  store.reportTransientFailure(account.id, 60_000, 3, 'upstream 503');
  assert.equal(store.account(account.id)!.consecutiveFailures, 1);
  assert.equal(store.availability().available, 1, 'a single blip must not move a pinned client');
  store.reportTransientFailure(account.id, 60_000, 3, 'upstream 503');
  assert.equal(store.availability().available, 1);
  store.reportTransientFailure(account.id, 60_000, 3, 'upstream 503');
  assert.equal(store.availability().available, 0);
  assert.ok((store.availability().retryAfterSeconds ?? 0) > 0);
  store.reportSuccess(account.id);
  assert.equal(store.availability().available, 1);
});

test('failure quarantines an account with backoff and success clears it', (t) => {
  const { store } = storeFixture(t);
  const account = store.upsertAccount({
    name: '',
    note: '',
    source: 'manual',
    accessToken: 't',
    refreshToken: '',
    userId: 'u',
    domain: 'www.workbuddy.ai',
  });
  store.reportFailure(account.id, 1_000, 'boom');
  const after = store.account(account.id)!;
  assert.equal(after.consecutiveFailures, 1);
  assert.ok(after.quarantinedUntil > Date.now());
  assert.equal(after.lastError, 'boom');
  assert.equal(store.availability().available, 0);
  assert.equal(store.availability().coolingDown, 1);

  store.reportSuccess(account.id);
  const recovered = store.account(account.id)!;
  assert.equal(recovered.consecutiveFailures, 0);
  assert.equal(recovered.quarantinedUntil, 0);
  assert.equal(store.availability().available, 1);
});

test('disabled and reauth accounts are excluded from availability', (t) => {
  const { store } = storeFixture(t);
  const first = store.upsertAccount({
    name: '',
    note: '',
    source: 'manual',
    accessToken: 't1',
    refreshToken: '',
    userId: 'u1',
    domain: 'www.workbuddy.ai',
  });
  const second = store.upsertAccount({
    name: '',
    note: '',
    source: 'manual',
    accessToken: 't2',
    refreshToken: '',
    userId: 'u2',
    domain: 'www.workbuddy.ai',
  });
  store.patchAccount(first.id, { enabled: false });
  store.markReauth(second.id, 'expired');
  const availability = store.availability();
  assert.deepEqual(
    {
      total: availability.total,
      disabled: availability.disabled,
      needsReauth: availability.needsReauth,
      available: availability.available,
    },
    { total: 2, disabled: 1, needsReauth: 1, available: 0 },
  );
});

test('client API keys are hashed and authenticated', (t) => {
  const { store, db } = storeFixture(t);
  const created = store.addKey('laptop');
  assert.match(created.key, /^sk-wk-/);
  assert.equal(created.record.prefix, created.key.slice(0, 12));
  const row = db.prepare('SELECT hash FROM api_keys WHERE id=?').get(created.record.id) as { hash: string };
  assert.notEqual(row.hash, created.key);
  assert.equal(store.authenticateKey(created.key), created.record.id);
  assert.equal(store.authenticateKey('sk-wk-nope'), null);
  assert.equal(store.keys()[0]!.name, 'laptop');
  assert.equal(store.removeKey(created.record.id), true);
  assert.equal(store.authenticateKey(created.key), null);
});

test('settings round-trip and reject unknown keys', (t) => {
  const { store } = storeFixture(t);
  const settings = store.settings();
  assert.equal(settings.strategy, 'round-robin');
  const saved = store.saveSettings({ ...settings, strategy: 'random', pool: { cooldownSeconds: 5 } });
  assert.equal(saved.strategy, 'random');
  assert.equal(store.settings().pool.cooldownSeconds, 5);
  assert.throws(() => store.saveSettings({ ...settings, nonsense: true }));
});

test('catalog import preserves panel state and drops models that disappeared', (t) => {
  const { store } = storeFixture(t);
  const catalog = bundledCatalog();
  const first = catalog.models[0]!;
  assert.ok(catalog.models.length >= 2);
  store.importCatalog(catalog);
  assert.equal(store.models().length, catalog.models.length);
  store.patchModel(first.id, {
    enabled: false,
    context_window: first.x_workbuddy.context_window?.supportedLengths[0],
  });
  assert.equal(store.model(first.id)!.enabled, false);

  const second = catalog.models[1]!;
  store.patchModel(second.id, { enabled: false });
  store.importCatalog({ ...catalog, models: catalog.models.slice(1) });
  assert.equal(store.model(first.id), undefined, 'models missing from the catalog are removed');
  assert.equal(store.model(second.id)!.enabled, false, 'panel state survives a catalog import');
  assert.equal(store.patchModel('missing', { enabled: true }), undefined);
});

test('the agent whitelist decides which models clients can see', (t) => {
  const { store } = storeFixture(t);
  const catalog = bundledCatalog();
  store.importCatalog({ ...catalog, agents: [{ name: 'cli', models: [catalog.models[0]!.id] }] });
  assert.equal(store.models().length, catalog.models.length);
  assert.deepEqual(
    store.exposedModels().map((model) => model.id),
    [catalog.models[0]!.id],
  );
  assert.equal(store.modelsForAgent('missing-agent').length, 0);
  store.patchModel(catalog.models[0]!.id, { enabled: false });
  assert.equal(store.exposedModels().length, 0);
});

test('request logs are recorded, filtered and pruned', (t) => {
  const { store } = storeFixture(t);
  const base = {
    requestId: 'req-1',
    timestamp: new Date().toISOString(),
    apiKeyId: 'key-1',
    apiKeyName: 'laptop',
    model: 'deepseek-v4.1-flash',
    accountId: null,
    stream: false,
    status: 200,
    durationMs: 12,
    inputTokens: 3,
    outputTokens: 4,
    totalTokens: 7,
    credits: 5,
    error: null,
  };
  store.recordLog(base);
  store.recordLog({ ...base, requestId: 'req-2', status: 500, error: 'upstream_error' });
  assert.equal(store.logs().total, 2);
  assert.equal(store.logs({ status: 'error' }).total, 1);
  assert.equal(store.logs({ model: 'deepseek-v4.1-flash' }).total, 2);
  assert.equal(store.logs({ apiKeyId: 'key-1' }).total, 2);
  const stats = store.stats();
  assert.equal(stats.requests24h, 2);
  assert.equal(stats.errors24h, 1);
  assert.equal(stats.tokens24h, 14);
  assert.equal(stats.credits24h, 10);
  assert.equal(stats.perModel[0]!.model, 'deepseek-v4.1-flash');
  store.clearLogs();
  assert.equal(store.logs().total, 0);
});

test('log retention prunes by age and count', (t) => {
  const { store } = storeFixture(t);
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  store.recordLog({
    requestId: 'old',
    timestamp: old,
    apiKeyId: null,
    apiKeyName: null,
    model: 'm',
    accountId: null,
    stream: false,
    status: 200,
    durationMs: 1,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    error: null,
  });
  const settings = { ...store.settings(), logging: { retentionDays: 30, maxEntries: 100 } };
  assert.equal(store.pruneLogs(settings), 1);
  assert.equal(store.logs().total, 0);
});
