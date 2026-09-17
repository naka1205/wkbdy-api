/**
 * Import the encrypted account store of the original wkbdy2api gateway.
 *
 *   WKB2API_ACCOUNT_STORE_PATH=../WkBdy2api/data/accounts.enc \
 *   WKB2API_ACCOUNT_STORE_KEY_FILE=../WkBdy2api/account-store.key \
 *   npm run migrate
 *
 * The legacy envelope is AES-256-GCM with a base64 nonce, ciphertext and tag,
 * and the payload is a snapshot listing accounts with their credentials. Both
 * the upstream URL and the panel then keep working against the new database.
 */
import { createDecipheriv } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadEnv, defaultSettings } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { Vault } from '../src/crypto.js';
import { Store } from '../src/store.js';

type LegacySnapshot = {
  version: 1;
  strategy?: 'round-robin' | 'random';
  accounts: Array<{
    label: string;
    note?: string;
    credential: {
      accessToken: string;
      userId: string;
      domain: string;
      oauthOrigin?: string;
      refreshToken?: string;
      expiresAt?: number;
      refreshExpiresAt?: number;
    };
  }>;
};

function decryptLegacy(key: Buffer, content: string): LegacySnapshot {
  const envelope = JSON.parse(content) as { iv: string; ciphertext: string; tag: string };
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plaintext) as LegacySnapshot;
}

async function readLegacyKey(path: string): Promise<Buffer> {
  const raw = await readFile(path);
  const key = raw.length === 32 ? raw : Buffer.from(raw.toString('utf8').trim(), 'base64');
  if (key.length !== 32)
    throw new Error('The legacy account-store key must be 32 raw bytes or its base64 encoding.');
  return key;
}

const storePath = process.env.WKB2API_ACCOUNT_STORE_PATH;
const keyPath = process.env.WKB2API_ACCOUNT_STORE_KEY_FILE;
if (!storePath || !keyPath) {
  console.error('Set WKB2API_ACCOUNT_STORE_PATH and WKB2API_ACCOUNT_STORE_KEY_FILE to run the migration.');
  process.exit(1);
}

const env = loadEnv();
const db = openDatabase(env.dataDir);
try {
  const store = new Store(db, new Vault(env.dataDir, env.encryptionKey));
  store.seedSettings({
    ...defaultSettings,
    ...(env.upstreamUrl
      ? {
          upstream: {
            url: env.upstreamUrl,
            userAgent: env.upstreamUserAgent ?? defaultSettings.upstream.userAgent,
          },
        }
      : {}),
  });
  const snapshot = decryptLegacy(
    await readLegacyKey(resolve(keyPath)),
    await readFile(resolve(storePath), 'utf8'),
  );
  if (snapshot.strategy) {
    const settings = store.settings();
    if (settings.strategy !== snapshot.strategy)
      store.saveSettings({ ...settings, strategy: snapshot.strategy });
  }
  let imported = 0;
  for (const account of snapshot.accounts) {
    store.upsertAccount({
      name: account.label,
      note: account.note ?? '',
      source: account.credential.oauthOrigin ? 'oauth' : 'manual',
      accessToken: account.credential.accessToken,
      refreshToken: account.credential.refreshToken ?? '',
      userId: account.credential.userId,
      domain: account.credential.domain,
      ...(account.credential.oauthOrigin ? { oauthOrigin: account.credential.oauthOrigin } : {}),
      ...(account.credential.expiresAt ? { expiresAt: account.credential.expiresAt } : {}),
      ...(account.credential.refreshExpiresAt
        ? { refreshExpiresAt: account.credential.refreshExpiresAt }
        : {}),
    });
    imported += 1;
  }
  console.log(`Migrated ${imported} accounts from ${storePath} into ${env.dataDir}/wkbdy.db.`);
} finally {
  db.close();
}
