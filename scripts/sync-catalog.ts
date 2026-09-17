/**
 * Import a WorkBuddy product catalog file into the database.
 *
 *   npm run sync:catalog                 # uses WKB2API_CATALOG_PATH
 *   npm run sync:catalog -- ./other.json # explicit path
 *
 * Panel state (enabled flags and selected context windows) is preserved for
 * models that still exist in the file.
 */
import { resolve } from 'node:path';
import { loadEnv } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { Vault } from '../src/crypto.js';
import { Store } from '../src/store.js';
import { syncCatalog } from '../src/routes/admin.js';

const env = loadEnv();
const catalogPath = resolve(process.argv[2] ?? env.catalogPath);
const db = openDatabase(env.dataDir);
try {
  const store = new Store(db, new Vault(env.dataDir, env.encryptionKey));
  const summary = await syncCatalog(catalogPath, store);
  const models = store.models();
  console.log(
    `Catalog imported from ${catalogPath}: ${summary.added} added, ${summary.updated} updated, ${summary.removed} removed.`,
  );
  console.log(`Stored models: ${models.length}, exposed to clients: ${store.exposedModels().length}.`);
  for (const agent of store.catalog().agents)
    console.log(`Agent '${agent.name}': ${agent.models.length} models.`);
} finally {
  db.close();
}
