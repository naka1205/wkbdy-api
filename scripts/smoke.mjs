import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const listener = createServer();
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const dataDir = mkdtempSync(join(tmpdir(), 'wkbdy-production-smoke-'));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['dist/index.js'], {
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    PUBLIC_BASE_URL: base,
    DATA_DIR: dataDir,
    STATIC_DIR: join(process.cwd(), 'static'),
    WKB2API_CATALOG_PATH: join(process.cwd(), 'config/wb_v3config.public.json'),
    ADMIN_PASSWORD: 'smoke-test-password',
    API_KEYS: 'sk-wk-smoke-test-key',
    LOG_LEVEL: 'silent',
    TOKEN_ENCRYPTION_KEY: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let diagnostics = '';
child.stderr.on('data', (data) => {
  diagnostics += data;
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 100 && child.exitCode === null; attempt++) {
    try {
      ready = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(200) })).ok;
    } catch {}
    if (ready) break;
    await delay(50);
  }
  assert.ok(ready, `Compiled server did not start: ${diagnostics}`);

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok', version: '1.0.0' });
  assert.equal((await fetch(`${base}/api/admin/accounts`)).status, 401);
  assert.equal((await fetch(`${base}/v1/models`)).status, 401);

  const models = await fetch(`${base}/v1/models`, {
    headers: { Authorization: 'Bearer sk-wk-smoke-test-key' },
  });
  assert.equal(models.status, 200);
  const catalog = await models.json();
  assert.ok(catalog.data.length > 0, 'the catalog file must seed /v1/models');
  assert.ok(catalog.data.every((model) => model.object === 'model'));

  const login = await fetch(`${base}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Request': '1' },
    body: JSON.stringify({ password: 'smoke-test-password' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const accounts = await fetch(`${base}/api/admin/accounts`, { headers: { Cookie: cookie } });
  assert.deepEqual((await accounts.json()).accounts, []);

  const home = await fetch(base);
  if (home.status === 200 && home.headers.get('content-type')?.includes('text/html')) {
    const html = await home.text();
    const script = html.match(/src="([^"]+\.js)"/);
    assert.ok(script, 'the admin build must reference a hashed bundle');
    assert.equal((await fetch(new URL(script[1], `${base}/`))).status, 200);
  } else {
    console.log('Skipping admin asset checks: build wkbdy-api-admin with npm run build:deploy');
  }

  console.log('Production smoke passed: compiled API, admin session, client key auth, catalog seeding.');
} finally {
  if (child.exitCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited;
    clearTimeout(deadline);
  }
  rmSync(dataDir, { recursive: true, force: true });
}
