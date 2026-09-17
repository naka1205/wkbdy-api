import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NoAvailableAccountsError } from '../src/errors.js';
import { fixture, type Fixture } from './helpers.js';

const SECOND = 'sk-wk-second-key-0123456789abcdef';

function addAccount(context: Fixture, name: string, userId: string) {
  return context.store.upsertAccount({
    name,
    note: '',
    source: 'manual',
    accessToken: `token-for-${userId}`,
    refreshToken: '',
    userId,
    domain: 'www.workbuddy.ai',
  });
}

function keyId(context: Fixture, name = 'Initial key 1'): string {
  return context.store.keys().find((key) => key.name === name)!.id;
}

test('a client key keeps one account while that account is healthy', async (t) => {
  const context = await fixture(t);
  const second = addAccount(context, 'second', 'user-2');
  const first = context.accounts.list().find((account) => account.user_id === 'user-1')!;
  const id = keyId(context);

  const initial = await context.accounts.getCredential(id);
  assert.equal(initial.accountId, first.id);
  const repeat = await context.accounts.getCredential(id);
  assert.equal(repeat.accountId, first.id, 'the second request reuses the assigned account');
  assert.equal(repeat.accessToken, 'test-access-token-value');
  assert.equal(context.store.binding(id)?.accountId, first.id);

  // An unclaimed account is preferred for the next key, so keys spread out.
  context.store.addKey('second key', SECOND);
  const otherKeyId = keyId(context, 'second key');
  const other = await context.accounts.getCredential(otherKeyId);
  assert.equal(other.accountId, second.id);
});

test('a quarantined account releases its key for the next request', async (t) => {
  const context = await fixture(t);
  const second = addAccount(context, 'second', 'user-2');
  const first = context.accounts.list().find((account) => account.user_id === 'user-1')!;
  const id = keyId(context);

  assert.equal((await context.accounts.getCredential(id)).accountId, first.id);
  context.store.reportFailure(first.id, 60_000, 'upstream 502');

  const next = await context.accounts.getCredential(id);
  assert.equal(next.accountId, second.id, 'the key moves off the quarantined account');
  assert.equal(context.store.binding(id)?.accountId, second.id);

  // Recovering the first account does not steal the key back.
  context.store.reportSuccess(first.id);
  assert.equal((await context.accounts.getCredential(id)).accountId, second.id);
});

test('a paid model that ran out of credits still serves free models', async (t) => {
  const context = await fixture(t);
  const account = context.store.accounts()[0]!;
  context.store.markQuotaExhausted(account.id, 600_000, 'Credits exhausted.', {
    model: 'gpt-5.6-sol',
  });

  // A credit-consuming model steps over it...
  await assert.rejects(
    () => context.accounts.getCredential(undefined, true),
    (error: unknown) => error instanceof NoAvailableAccountsError && /out of credits/.test(error.message),
  );
  // ...a free model keeps using it.
  assert.equal((await context.accounts.getCredential(undefined, false)).accountId, account.id);

  // An empty balance is not a broken account: no strikes, no quarantine.
  const parked = context.store.account(account.id)!;
  assert.equal(parked.cooldownReason, 'quota');
  assert.equal(parked.consecutiveFailures, 0);
  assert.equal(parked.quarantinedUntil, 0);

  // Once the probe window passes the paid model tries the account again, so a
  // topped-up balance recovers without an operator.
  context.store.db
    .prepare('UPDATE accounts SET quota_retry_after=? WHERE id=?')
    .run(Date.now() - 1, account.id);
  assert.equal((await context.accounts.getCredential(undefined, true)).accountId, account.id);
});

test('disabling, signing out or deleting an account drops the assignment', async (t) => {
  const context = await fixture(t);
  addAccount(context, 'second', 'user-2');
  const first = context.accounts.list().find((account) => account.user_id === 'user-1')!;
  const id = keyId(context);

  await context.accounts.getCredential(id);
  context.store.patchAccount(first.id, { enabled: false });
  assert.equal(context.store.binding(id), undefined);
  const afterDisable = await context.accounts.getCredential(id);
  assert.notEqual(afterDisable.accountId, first.id);

  context.store.patchAccount(first.id, { enabled: true });
  context.store.bindAccount(id, first.id);
  context.store.markReauth(first.id, 'signed out');
  assert.equal(context.store.binding(id), undefined);

  context.store.bindAccount(id, first.id);
  context.store.removeAccount(first.id);
  assert.equal(context.store.binding(id), undefined);
});

test('deleting a client key removes its assignment', async (t) => {
  const context = await fixture(t);
  const id = keyId(context);
  await context.accounts.getCredential(id);
  assert.ok(context.store.binding(id));
  context.store.removeKey(id);
  assert.equal(context.store.binding(id), undefined);
});

test('account pinning can be turned off per deployment', async (t) => {
  const context = await fixture(t);
  addAccount(context, 'second', 'user-2');
  const settings = context.store.settings();
  context.store.saveSettings({ ...settings, pool: { ...settings.pool, accountBinding: 'none' } });
  const id = keyId(context);

  const first = await context.accounts.getCredential(id);
  const second = await context.accounts.getCredential(id);
  assert.notEqual(first.accountId, second.accountId, 'each request picks an account on its own');
  assert.deepEqual(context.store.bindings(), []);
});

test('chat completions from one key stay on one account', async (t) => {
  const context = await fixture(t);
  addAccount(context, 'second', 'user-2');
  const payload = { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] };
  for (let index = 0; index < 3; index++) {
    const response = await context.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: context.apiHeaders,
      payload,
    });
    assert.equal(response.statusCode, 200);
  }
  const accounts = new Set(context.store.logs().entries.map((entry) => entry.accountId));
  assert.equal(accounts.size, 1, 'every request was served by the same account');
});

test('an empty pool does not break later round-robin rotation', async (t) => {
  const context = await fixture(t);
  for (const account of context.store.accounts()) context.store.removeAccount(account.id);
  await assert.rejects(() => context.accounts.getCredential());

  const first = addAccount(context, 'first', 'user-a');
  const second = addAccount(context, 'second', 'user-b');
  const settings = context.store.settings();
  context.store.saveSettings({ ...settings, pool: { ...settings.pool, accountBinding: 'none' } });
  const picks = [
    (await context.accounts.getCredential()).accountId,
    (await context.accounts.getCredential()).accountId,
    (await context.accounts.getCredential()).accountId,
  ];
  assert.deepEqual(picks, [first.id, second.id, first.id], 'round-robin keeps rotating');
});

test('the panel can release an assignment and reports it', async (t) => {
  const context = await fixture(t);
  const account = context.accounts.list()[0]!;
  await context.accounts.getCredential(keyId(context));

  const listed = await context.app.inject({
    method: 'GET',
    url: '/api/admin/accounts',
    headers: context.headers,
  });
  assert.equal(
    listed.json<{ accounts: Array<{ bound_key_name: string | null }> }>().accounts[0]!.bound_key_name,
    'Initial key 1',
  );

  const released = await context.app.inject({
    method: 'POST',
    url: `/api/admin/accounts/${account.id}/release`,
    headers: context.headers,
  });
  assert.equal(released.statusCode, 200);
  assert.equal(released.json<{ released: boolean }>().released, true);
  assert.equal(context.store.binding(keyId(context)), undefined);
  assert.equal(context.store.keys()[0]!.accountId, null);
});
