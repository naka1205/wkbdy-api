import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCatalogUrl } from '../src/catalog-sync.js';
import { loadEnv } from '../src/config.js';

const base = { ADMIN_PASSWORD: 'unit-test-password' } as NodeJS.ProcessEnv;

test('blank optional URLs in .env mean "unset" instead of failing validation', () => {
  const env = loadEnv({ ...base, PUBLIC_BASE_URL: '', WKB2API_CATALOG_URL: '' });
  assert.equal(env.catalogUrl, undefined);
  assert.equal(env.publicBaseUrl, 'http://localhost:7891');
});

test('a catalog URL override is validated at startup', () => {
  assert.throws(() => loadEnv({ ...base, WKB2API_CATALOG_URL: 'not-a-url' }), /WKB2API_CATALOG_URL/);
  assert.equal(
    loadEnv({ ...base, WKB2API_CATALOG_URL: 'https://staging.example/v3/config' }).catalogUrl,
    'https://staging.example/v3/config',
  );
});

test('without an override the catalog URL follows the chat upstream', () => {
  const env = loadEnv(base);
  assert.equal(
    resolveCatalogUrl('https://www.workbuddy.ai/v2/chat/completions', env.catalogUrl),
    'https://www.workbuddy.ai/v3/config',
  );
});
