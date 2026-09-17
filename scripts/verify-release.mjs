import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8');

const pkg = JSON.parse(read('package.json'));
assert.equal(pkg.private, true);
assert.ok(pkg.engines.node.includes('22'), 'the service targets Node 22 or newer');
assert.ok(pkg.dependencies['better-sqlite3'], 'accounts are persisted in SQLite');

// No secrets, tokens or personal data may be committed with the source tree.
const forbidden = [
  /sk-wk-[A-Za-z0-9_-]{20}/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /BEGIN [A-Z ]*PRIVATE KEY/,
];
const files = [
  'README.md',
  '.env.example',
  'config/wb_v3config.public.json',
  'src/config.ts',
  'src/store.ts',
  'docs/configuration.md',
];
for (const file of files) {
  const content = read(file);
  for (const pattern of forbidden) assert.ok(!pattern.test(content), `${file} must not contain credentials`);
}

// The environment template must document every variable loadEnv reads.
const envSource = read('src/config.ts');
const example = read('.env.example');
for (const name of [
  'HOST',
  'PORT',
  'ADMIN_PASSWORD',
  'DATA_DIR',
  'STATIC_DIR',
  'LOG_LEVEL',
  'API_KEYS',
  'PUBLIC_BASE_URL',
  'WKB2API_UPSTREAM_URL',
  'WKB2API_UPSTREAM_UA',
  'WKB2API_CATALOG_PATH',
  'WKB2API_CREDENTIALS_PATH',
  'TOKEN_ENCRYPTION_KEY',
]) {
  assert.ok(envSource.includes(name) || example.includes(name), `${name} must be handled by the service`);
  assert.ok(example.includes(name), `${name} must be documented in .env.example`);
}

// Every documented admin route must exist in the route module.
const adminSource = read('src/routes/admin.ts');
const adminDoc = read('docs/admin-api.md');
for (const route of [
  '/auth/login',
  '/auth/logout',
  '/auth/session',
  '/auth/password',
  '/overview',
  '/accounts',
  '/accounts/import',
  '/models',
  '/models/sync',
  '/keys',
  '/logs',
  '/settings',
  '/oauth/start',
]) {
  assert.ok(adminSource.includes(`'${route}`), `${route} is missing from src/routes/admin.ts`);
  assert.ok(adminDoc.includes(route), `${route} is missing from docs/admin-api.md`);
}
console.log('Release verification passed: environment, routes and secret hygiene.');
