import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OAuthBroker, AUTH_ORIGIN } from '../src/oauth.js';

const token = (payload: Record<string, unknown>) =>
  `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;

function mockOauthFetch(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ path: string; method: string; headers: Headers }> = [];
  const fetchFn = (async (url: string | URL, init?: RequestInit) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.origin, AUTH_ORIGIN);
    const path = parsed.pathname + parsed.search;
    calls.push({ path, method: init?.method ?? 'GET', headers: new Headers(init?.headers) });
    const respond = (data: unknown) =>
      new Response(JSON.stringify({ code: 0, data }), { headers: { 'Content-Type': 'application/json' } });
    if (path.startsWith('/v2/plugin/auth/state')) {
      return respond({ authUrl: 'https://www.workbuddy.ai/login/plugin?state=abc', state: 'abc' });
    }
    if (path.startsWith('/v2/plugin/auth/token/refresh')) {
      return respond(
        overrides.refresh ?? {
          accessToken: token({ sub: 'user-1' }),
          refreshToken: 'fresh-refresh',
          domain: 'www.workbuddy.ai',
          expiresIn: 3600,
        },
      );
    }
    if (path.startsWith('/v2/plugin/auth/token')) {
      return respond({
        accessToken: token({ sub: 'user-1' }),
        refreshToken: 'refresh-1',
        tokenType: 'Bearer',
        domain: 'www.workbuddy.ai',
        expiresIn: 3600,
      });
    }
    if (path.startsWith('/v2/plugin/login/account')) return respond({ uid: 'user-1' });
    if (path.startsWith('/v2/plugin/accounts')) return respond({ accounts: [{ uid: 'user-1' }] });
    return respond({});
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

test('a browser login completes by polling the upstream and hands the credential to the pool', async () => {
  const { fetchFn, calls } = mockOauthFetch();
  const completed: Array<{ userId: string; note?: string }> = [];
  const broker = new OAuthBroker({
    fetchFn,
    pollIntervalMs: 1,
    userAgent: 'WorkBuddy/2.137.1',
    onComplete: async (credential, note) => {
      completed.push({ userId: credential.userId, ...(note ? { note } : {}) });
      return 'label-1';
    },
  });
  try {
    const started = await broker.start('session-owner', 'note');
    assert.equal(started.status, 'pending');
    assert.match(started.authorization_url, /^https:\/\/www\.workbuddy\.ai\/login\/plugin\?state=abc/);
    assert.match(started.authorization_url, /version=2\.137\.1/);

    for (
      let attempt = 0;
      attempt < 50 && broker.status(started.id, 'session-owner').status !== 'completed';
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const status = broker.status(started.id, 'session-owner');
    assert.equal(status.status, 'completed');
    assert.equal(status.account_label, 'label-1');
    assert.deepEqual(completed, [{ userId: 'user-1', note: 'note' }]);
    assert.ok(calls.some((call) => call.path.startsWith('/v2/plugin/auth/token?state=')));
    assert.ok(calls.some((call) => call.path.startsWith('/v2/plugin/accounts')));
  } finally {
    broker.close();
  }
});

test('a login transaction is private to its owner and can be cancelled', async () => {
  const { fetchFn } = mockOauthFetch();
  const broker = new OAuthBroker({ fetchFn, pollIntervalMs: 1, onComplete: async () => 'label' });
  try {
    const started = await broker.start('owner-a');
    assert.throws(() => broker.status(started.id, 'owner-b'), /oauth_session_not_found|Invalid/);
    assert.equal(broker.cancel(started.id, 'owner-a').status, 'cancelled');
  } finally {
    broker.close();
  }
});

test('refreshCredential exchanges only web-login credentials', async () => {
  const { fetchFn, calls } = mockOauthFetch();
  const broker = new OAuthBroker({ fetchFn, onComplete: async () => 'label' });
  try {
    const refreshed = await broker.refreshCredential({
      accessToken: 'old',
      userId: 'user-1',
      domain: 'www.workbuddy.ai',
      oauthOrigin: AUTH_ORIGIN,
      refreshToken: 'refresh-1',
    });
    assert.equal(refreshed.refreshToken, 'fresh-refresh');
    assert.equal(refreshed.userId, 'user-1');
    assert.ok(calls.some((call) => call.path.startsWith('/v2/plugin/auth/token/refresh')));

    await assert.rejects(
      () => broker.refreshCredential({ accessToken: 'old', userId: 'user-1', domain: 'www.workbuddy.ai' }),
      /oauth_reauthentication_required|reauthentication/i,
    );
  } finally {
    broker.close();
  }
});
