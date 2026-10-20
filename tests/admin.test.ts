import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogPayload, json, fixture } from './helpers.js';

const token = (payload: Record<string, unknown>) =>
  `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;

test('the overview reports pool, models, availability and usage', async (t) => {
  const context = await fixture(t);
  const overview = await context.app.inject({
    method: 'GET',
    url: '/api/admin/overview',
    headers: context.headers,
  });
  assert.equal(overview.statusCode, 200);
  const body = overview.json<{
    version: string;
    availability: { total: number; available: number };
    pool: { size: number; strategy: string; accounts: Array<{ user_id: string }> };
    models: { total: number; enabled: number };
    keys: number;
    stats: { requests24h: number };
    upstream: { url: string; user_agent: string };
  }>();
  assert.equal(body.version, '1.0.0');
  assert.equal(body.availability.total, 1);
  assert.equal(body.availability.available, 1);
  assert.equal(body.pool.strategy, 'round-robin');
  assert.equal(body.pool.accounts[0]!.user_id, 'user-1');
  assert.equal(body.models.total, context.store.models().length);
  assert.equal(body.keys, 1);
  assert.equal(body.stats.requests24h, 0);
  assert.match(body.upstream.url, /^https:\/\/www\.workbuddy\.ai/);
});

test('accounts can be added, verified, patched and removed', async (t) => {
  const context = await fixture(t);
  const added = await context.app.inject({
    method: 'POST',
    url: '/api/admin/accounts',
    headers: context.headers,
    payload: {
      token: token({
        sub: 'user-2',
        email: 'user-2@example.com',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
      note: 'work laptop',
    },
  });
  assert.equal(added.statusCode, 200);
  const account = added.json<{
    account: {
      id: string;
      user_id: string;
      email: string | null;
      note: string;
      ok: boolean;
      expires_at: number;
    };
  }>().account;
  assert.equal(account.user_id, 'user-2');
  assert.equal(account.email, 'user-2@example.com');
  assert.equal(account.note, 'work laptop');
  assert.equal(account.ok, true);
  assert.ok(account.expires_at > Date.now());
  assert.equal(context.store.accounts().length, 2);

  const listed = await context.app.inject({
    method: 'GET',
    url: '/api/admin/accounts',
    headers: context.headers,
  });
  const accounts = listed.json<{ accounts: Array<Record<string, unknown>> }>().accounts;
  assert.equal(accounts.length, 2);
  assert.ok(!('accessToken' in accounts[0]!), 'account payloads must never include secrets');

  const patched = await context.app.inject({
    method: 'PATCH',
    url: `/api/admin/accounts/${account.id}`,
    headers: context.headers,
    payload: { enabled: false, note: '' },
  });
  assert.equal(patched.json<{ account: { enabled: boolean } }>().account.enabled, false);
  assert.equal(context.store.availability().available, 1);

  const verified = await context.app.inject({
    method: 'POST',
    url: `/api/admin/accounts/${account.id}/verify`,
    headers: context.headers,
  });
  assert.deepEqual(verified.json<{ ok: boolean }>().ok, true);
  const verifyCall = context.upstream.last!;
  for (const name of [
    'x-conversation-id',
    'x-conversation-request-id',
    'x-conversation-message-id',
  ]) {
    assert.ok(verifyCall.headers.get(name), `credential verification must send ${name}`);
  }

  context.upstream.handler = () => json({ code: 401, msg: 'bad token' }, 401);
  const rejected = await context.app.inject({
    method: 'POST',
    url: `/api/admin/accounts/${account.id}/verify`,
    headers: context.headers,
  });
  assert.equal(rejected.json<{ ok: boolean; detail: string }>().ok, false);

  assert.equal(
    (
      await context.app.inject({
        method: 'DELETE',
        url: `/api/admin/accounts/${account.id}`,
        headers: context.headers,
      })
    ).statusCode,
    200,
  );
  assert.equal(context.store.accounts().length, 1);
  assert.equal(
    (
      await context.app.inject({
        method: 'DELETE',
        url: `/api/admin/accounts/${account.id}`,
        headers: context.headers,
      })
    ).statusCode,
    404,
  );
});

test('adding an account validates the token and derives the user id from claims', async (t) => {
  const context = await fixture(t);
  const tooShort = await context.app.inject({
    method: 'POST',
    url: '/api/admin/accounts',
    headers: context.headers,
    payload: { token: 'short' },
  });
  assert.equal(tooShort.statusCode, 400);

  const opaque = await context.app.inject({
    method: 'POST',
    url: '/api/admin/accounts',
    headers: context.headers,
    payload: { token: 'an-opaque-token-without-claims' },
  });
  assert.equal(opaque.statusCode, 400);
  assert.equal(opaque.json<{ error: { code: string } }>().error.code, 'invalid_request');

  context.upstream.handler = () => json({ code: 401, msg: 'rejected' }, 401);
  const rejected = await context.app.inject({
    method: 'POST',
    url: '/api/admin/accounts',
    headers: context.headers,
    payload: { token: token({ sub: 'user-3' }), user_id: 'user-3' },
  });
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejected.json<{ error: { code: string } }>().error.code, 'account_verification_failed');
  assert.equal(context.store.accounts().length, 1);

  const skipped = await context.app.inject({
    method: 'POST',
    url: '/api/admin/accounts',
    headers: context.headers,
    payload: { token: token({ sub: 'user-4' }), verify: false },
  });
  assert.equal(skipped.statusCode, 200);
  assert.equal(skipped.json<{ account: { user_id: string; source: string } }>().account.source, 'manual');
  assert.equal(context.store.accounts().length, 2);
});

test('local credential import is wired to WKB2API_CREDENTIALS_PATH', async (t) => {
  const context = await fixture(t);
  const unavailable = await context.app.inject({
    method: 'POST',
    url: '/api/admin/accounts/import',
    headers: context.headers,
  });
  assert.equal(unavailable.statusCode, 400);
  assert.equal(unavailable.json<{ error: { code: string } }>().error.code, 'import_unavailable');
});

test('model state can be synced and toggled through the admin API', async (t) => {
  const context = await fixture(t);
  const listed = await context.app.inject({
    method: 'GET',
    url: '/api/admin/models',
    headers: context.headers,
  });
  assert.equal(listed.json<{ models: unknown[] }>().models.length, context.store.models().length);

  const firstId = context.store.models()[0]!.id;
  const patched = await context.app.inject({
    method: 'PATCH',
    url: `/api/admin/models/${firstId}`,
    headers: context.headers,
    payload: { enabled: false },
  });
  assert.equal(patched.json<{ model: { enabled: boolean } }>().model.enabled, false);

  const synced = await context.app.inject({
    method: 'POST',
    url: '/api/admin/models/sync',
    headers: context.headers,
  });
  assert.equal(synced.statusCode, 200);
  assert.ok(synced.json<{ synced_at: string }>().synced_at);
  assert.equal(context.store.model(firstId)!.enabled, false, 'sync keeps the panel toggle');

  const missing = await context.app.inject({
    method: 'PATCH',
    url: '/api/admin/models/nope',
    headers: context.headers,
    payload: { enabled: true },
  });
  assert.equal(missing.statusCode, 404);
});

test('logs can be filtered and cleared', async (t) => {
  const context = await fixture(t);
  await context.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: context.apiHeaders,
    payload: { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] },
  });
  const logs = await context.app.inject({
    method: 'GET',
    url: '/api/admin/logs?limit=10',
    headers: context.headers,
  });
  assert.equal(logs.json<{ total: number; entries: unknown[] }>().total, 1);
  assert.equal(logs.json<{ entries: unknown[] }>().entries.length, 1);
  const errors = await context.app.inject({
    method: 'GET',
    url: '/api/admin/logs?status=error',
    headers: context.headers,
  });
  assert.equal(errors.json<{ total: number }>().total, 0);
  assert.equal(
    (await context.app.inject({ method: 'DELETE', url: '/api/admin/logs', headers: context.headers }))
      .statusCode,
    200,
  );
  assert.equal(context.store.logs().total, 0);
  const bad = await context.app.inject({
    method: 'GET',
    url: '/api/admin/logs?limit=0',
    headers: context.headers,
  });
  assert.equal(bad.statusCode, 400);
});

test('settings are read, validated and applied to scheduling', async (t) => {
  const context = await fixture(t);
  const settings = (
    await context.app.inject({ method: 'GET', url: '/api/admin/settings', headers: context.headers })
  ).json<{
    settings: Record<string, unknown>;
  }>().settings;
  const updated = await context.app.inject({
    method: 'PUT',
    url: '/api/admin/settings',
    headers: context.headers,
    payload: { ...settings, strategy: 'random', pool: { cooldownSeconds: 30 } },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(context.store.settings().strategy, 'random');
  assert.equal(context.store.settings().pool.cooldownSeconds, 30);

  const invalid = await context.app.inject({
    method: 'PUT',
    url: '/api/admin/settings',
    headers: context.headers,
    payload: { ...settings, strategy: 'nope' },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(context.store.settings().strategy, 'random');
});

test('the panel reports the catalog endpoint it syncs from', async (t) => {
  const context = await fixture(t, { catalog: false });
  context.upstream.catalog = catalogPayload([{ id: 'alpha' }]);
  const synced = await context.app.inject({
    method: 'POST',
    url: '/api/admin/models/sync',
    headers: context.headers,
  });
  assert.equal(synced.statusCode, 200);
  assert.equal(
    synced.json<{ catalog_url: string }>().catalog_url,
    'https://www.workbuddy.ai/v3/config',
    'the URL is derived from the chat upstream',
  );

  const overview = await context.app.inject({
    method: 'GET',
    url: '/api/admin/overview',
    headers: context.headers,
  });
  assert.equal(
    overview.json<{ upstream: { catalog_url: string } }>().upstream.catalog_url,
    'https://www.workbuddy.ai/v3/config',
  );
});
