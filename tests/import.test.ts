import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalImportError, readLocalWorkBuddyAccounts } from '../src/import.js';
import { fixture } from './helpers.js';

const jwt = (payload: Record<string, unknown>) =>
  `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;

function credentialFile(t: { after: (fn: () => void) => void }, document: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'wkbdy-import-'));
  const path = join(dir, 'workbuddy.json');
  writeFileSync(path, typeof document === 'string' ? document : JSON.stringify(document));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path;
}

test('a machine credential file yields verified accounts and skips broken ones', async (t) => {
  const path = credentialFile(t, {
    account: { uid: 'user-1', email: 'person@example.com' },
    auth: {
      accessToken: jwt({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 }),
      domain: 'www.workbuddy.ai',
    },
    accounts: [
      {
        account: { uid: 'user-2', email: 'other@example.com' },
        auth: { accessToken: jwt({ sub: 'user-2', exp: Math.floor(Date.now() / 1000) + 3600 }) },
      },
      { account: { uid: 'user-3' }, auth: { accessToken: jwt({ sub: 'user-3', exp: 1 }) } },
      {
        account: { uid: 'user-4' },
        auth: { accessToken: jwt({ sub: 'user-9', exp: Math.floor(Date.now() / 1000) + 60 }) },
      },
    ],
  });
  const result = await readLocalWorkBuddyAccounts(path);
  assert.deepEqual(
    result.credentials.map((entry) => entry.credential.userId),
    ['user-1', 'user-2'],
  );
  assert.deepEqual(result.issues.map((issue) => issue.code).sort(), ['expired', 'identity_mismatch']);
  assert.match(result.credentials[0]!.note, /@example\.com/);
  assert.ok(!result.credentials[0]!.note.includes('signature'), 'notes must not echo tokens');
});

test('unreadable and malformed files produce typed errors', async () => {
  await assert.rejects(
    () => readLocalWorkBuddyAccounts('/definitely/missing.json'),
    (error: unknown) => {
      assert.ok(error instanceof LocalImportError);
      assert.equal(error.code, 'file_not_found');
      return true;
    },
  );
});

test('the import endpoint stores every credential it accepts', async (t) => {
  const path = credentialFile(t, {
    accounts: [
      {
        account: { uid: 'user-1' },
        auth: { accessToken: jwt({ sub: 'user-1', exp: Math.floor(Date.now() / 1000) + 3600 }) },
      },
      {
        account: { uid: 'user-2' },
        auth: { accessToken: jwt({ sub: 'user-2', exp: Math.floor(Date.now() / 1000) + 3600 }) },
      },
    ],
  });
  const context = await fixture(t, { env: { credentialsPath: path } });
  const response = await context.app.inject({
    method: 'POST',
    url: '/api/admin/accounts/import',
    headers: context.headers,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json<{ imported: number }>().imported, 2);
  const users = context.store
    .accounts()
    .map((account) => account.userId)
    .sort();
  assert.deepEqual(users, ['user-1', 'user-2']);
  assert.ok(context.store.accounts().every((account) => account.source === 'import'));
});
