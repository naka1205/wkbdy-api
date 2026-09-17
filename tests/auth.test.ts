import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API_KEY, ADMIN_PASSWORD, fixture } from './helpers.js';

test('every /v1 route requires a client API key', async (t) => {
  const context = await fixture(t);
  for (const url of ['/v1/models', '/v1/models/x']) {
    const anonymous = await context.app.inject({ method: 'GET', url });
    assert.equal(anonymous.statusCode, 401);
    assert.equal(anonymous.json<{ error: { code: string } }>().error.code, 'invalid_api_key');
  }
  const wrong = await context.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { authorization: 'Bearer sk-wk-wrong' },
    payload: { model: 'm', messages: [{ role: 'user', content: 'x' }] },
  });
  assert.equal(wrong.statusCode, 401);
  const accepted = await context.app.inject({
    method: 'GET',
    url: '/v1/models',
    headers: context.apiHeaders,
  });
  assert.equal(accepted.statusCode, 200);
});

test('client API keys created in the panel work immediately and stop after deletion', async (t) => {
  const context = await fixture(t);
  const created = await context.app.inject({
    method: 'POST',
    url: '/api/admin/keys',
    headers: context.headers,
    payload: { name: 'laptop' },
  });
  assert.equal(created.statusCode, 200);
  const { key, record } = created.json<{ key: string; record: { id: string } }>();
  assert.equal(
    (
      await context.app.inject({
        method: 'GET',
        url: '/v1/models',
        headers: { authorization: `Bearer ${key}` },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await context.app.inject({
        method: 'DELETE',
        url: `/api/admin/keys/${record.id}`,
        headers: context.headers,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await context.app.inject({
        method: 'GET',
        url: '/v1/models',
        headers: { authorization: `Bearer ${key}` },
      })
    ).statusCode,
    401,
  );
  assert.equal(API_KEY.startsWith('sk-wk-'), true);
});

test('admin routes demand a session cookie and the CSRF header', async (t) => {
  const context = await fixture(t);
  assert.equal((await context.app.inject({ method: 'GET', url: '/api/admin/overview' })).statusCode, 401);
  const csrf = await context.app.inject({
    method: 'POST',
    url: '/api/admin/auth/login',
    payload: { password: ADMIN_PASSWORD },
  });
  assert.equal(csrf.statusCode, 403);
  assert.equal(csrf.json<{ error: { code: string } }>().error.code, 'csrf_required');
  const wrong = await context.app.inject({
    method: 'POST',
    url: '/api/admin/auth/login',
    headers: { 'x-admin-request': '1' },
    payload: { password: 'nope-nope-nope' },
  });
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.json<{ error: { code: string } }>().error.code, 'invalid_password');
});

test('sign-in, session check, password change and sign-out', async (t) => {
  const context = await fixture(t);
  assert.deepEqual(
    (
      await context.app.inject({ method: 'GET', url: '/api/admin/auth/session', headers: context.headers })
    ).json(),
    { authenticated: true },
  );
  const changed = await context.app.inject({
    method: 'POST',
    url: '/api/admin/auth/password',
    headers: context.headers,
    payload: { current: ADMIN_PASSWORD, next: 'a-much-longer-password' },
  });
  assert.equal(changed.statusCode, 200);
  assert.deepEqual(
    (
      await context.app.inject({ method: 'GET', url: '/api/admin/auth/session', headers: context.headers })
    ).json(),
    { authenticated: false },
    'changing the password invalidates existing sessions',
  );

  const relogin = await context.app.inject({
    method: 'POST',
    url: '/api/admin/auth/login',
    headers: { 'x-admin-request': '1' },
    payload: { password: 'a-much-longer-password' },
  });
  const cookie = String(relogin.headers['set-cookie']).split(';')[0];
  assert.equal(
    (await context.app.inject({ method: 'GET', url: '/api/admin/overview', headers: { cookie } })).statusCode,
    200,
  );
  await context.app.inject({
    method: 'POST',
    url: '/api/admin/auth/logout',
    headers: { cookie, 'x-admin-request': '1' },
  });
  assert.equal(
    (await context.app.inject({ method: 'GET', url: '/api/admin/overview', headers: { cookie } })).statusCode,
    401,
  );
});

test('repeated wrong passwords are rate limited per client', async (t) => {
  const context = await fixture(t);
  for (let attempt = 0; attempt < 5; attempt++) {
    await context.app.inject({
      method: 'POST',
      url: '/api/admin/auth/login',
      headers: { 'x-admin-request': '1' },
      payload: { password: 'wrong-password' },
    });
  }
  const limited = await context.app.inject({
    method: 'POST',
    url: '/api/admin/auth/login',
    headers: { 'x-admin-request': '1' },
    payload: { password: ADMIN_PASSWORD },
  });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json<{ error: { code: string } }>().error.code, 'login_rate_limited');
});
