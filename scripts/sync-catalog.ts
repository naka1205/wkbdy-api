/**
 * Fetch the WorkBuddy product catalog from the upstream and merge it into the
 * database. The panel's "同步目录" button runs exactly the same code path.
 *
 *   npm run sync:catalog
 *
 * The endpoint rejects anonymous requests, so at least one usable account is
 * required. `WKB2API_CATALOG_URL` overrides the derived `{upstream}/v3/config`.
 */
import { Accounts } from '../src/accounts.js';
import { resolveCatalogUrl, syncCatalogFromUpstream } from '../src/catalog-sync.js';
import { loadEnv } from '../src/config.js';
import { Vault } from '../src/crypto.js';
import { openDatabase } from '../src/db.js';
import { Store } from '../src/store.js';

const env = loadEnv();
const db = openDatabase(env.dataDir);
try {
  const store = new Store(db, new Vault(env.dataDir, env.encryptionKey));
  const accounts = new Accounts(store, () => store.settings().pool.cooldownSeconds * 1000);
  const catalogUrl = () => resolveCatalogUrl(store.settings().upstream.url, env.catalogUrl);
  const summary = await syncCatalogFromUpstream({
    store,
    credentials: accounts,
    catalogUrl,
    userAgent: () => store.settings().upstream.userAgent,
  });
  console.log(
    `Catalog fetched from ${catalogUrl()}: ${summary.added} added, ${summary.updated} updated, ${summary.removed} removed.`,
  );
  console.log(
    `Stored models: ${store.models().length}, exposed to clients: ${store.exposedModels().length}.`,
  );
  for (const agent of store.catalog().agents)
    console.log(`Agent '${agent.name}': ${agent.models.length} models.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  db.close();
}
