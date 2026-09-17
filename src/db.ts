import Database from 'better-sqlite3';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function openDatabase(dataDir: string): Database.Database {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const path = join(dataDir, 'wkbdy.db');
  const db = new Database(path);
  chmodSync(path, 0o600);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual',
      access_token TEXT NOT NULL, refresh_token TEXT NOT NULL DEFAULT '', token_hash TEXT NOT NULL UNIQUE,
      user_id TEXT NOT NULL DEFAULT '', domain TEXT NOT NULL DEFAULT 'www.workbuddy.ai',
      email TEXT,
      oauth_origin TEXT,
      expires_at INTEGER, refresh_expires_at INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1, needs_reauth INTEGER NOT NULL DEFAULT 0,
      quarantined_until INTEGER NOT NULL DEFAULT 0, consecutive_failures INTEGER NOT NULL DEFAULT 0,
      requests INTEGER NOT NULL DEFAULT 0, tokens INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, last_used_at INTEGER, created_at TEXT NOT NULL, legacy_label TEXT UNIQUE
    );
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL, last_used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      description TEXT, credits TEXT,
      is_default INTEGER NOT NULL DEFAULT 0,
      max_input_tokens INTEGER, max_output_tokens INTEGER, temperature REAL,
      supports_images INTEGER NOT NULL DEFAULT 0,
      supports_tool_call INTEGER NOT NULL DEFAULT 0,
      supports_reasoning INTEGER NOT NULL DEFAULT 0,
      only_reasoning INTEGER NOT NULL DEFAULT 0,
      reasoning_can_disable_thinking INTEGER,
      reasoning_default_effort TEXT, reasoning_effort TEXT, reasoning_summary TEXT,
      context_default_length INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      selected_context_window INTEGER,
      position INTEGER NOT NULL DEFAULT 0,
      synced_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS model_context_lengths (
      model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
      length INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (model_id, length)
    );
    CREATE TABLE IF NOT EXISTS model_reasoning_efforts (
      model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
      effort TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (model_id, effort)
    );
    CREATE TABLE IF NOT EXISTS agents (
      name TEXT PRIMARY KEY, position INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS agent_models (
      agent TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
      model_id TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (agent, model_id)
    );
    CREATE TABLE IF NOT EXISTS agent_tags (
      agent TEXT NOT NULL REFERENCES agents(name) ON DELETE CASCADE,
      tag TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (agent, tag)
    );
    CREATE TABLE IF NOT EXISTS request_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL, timestamp TEXT NOT NULL,
      api_key_id TEXT, api_key_name TEXT, model TEXT NOT NULL, account_id TEXT,
      stream INTEGER NOT NULL, status INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0, credits REAL NOT NULL DEFAULT 0,
      cache_hit_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      task_id TEXT, session_id TEXT, trace_id TEXT, client_request_id TEXT,
      logical_request_id TEXT, client_attempt INTEGER, upstream_request_id TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_logs_time ON request_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_logs_model ON request_logs(model);
    -- Sticky account assignment: one client key keeps one upstream account for
    -- as long as that account stays usable. Deleting either side drops the row.
    CREATE TABLE IF NOT EXISTS account_bindings (
      api_key_id TEXT PRIMARY KEY REFERENCES api_keys(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      bound_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bindings_account ON account_bindings(account_id);
  `);
  // Additive migration for databases created by earlier builds.
  db.transaction(() => {
    const logColumns = (db.pragma('table_info(request_logs)') as { name: string }[]).map(
      (column) => column.name,
    );
    if (!logColumns.includes('api_key_id')) db.exec('ALTER TABLE request_logs ADD COLUMN api_key_id TEXT');
    if (!logColumns.includes('api_key_name'))
      db.exec('ALTER TABLE request_logs ADD COLUMN api_key_name TEXT');
    // WorkBuddy bills in credits; the upstream reports them in `usage.credit`.
    if (!logColumns.includes('credits'))
      db.exec('ALTER TABLE request_logs ADD COLUMN credits REAL NOT NULL DEFAULT 0');
    // Prompt-cache and reasoning telemetry, surfaced to clients and the panel.
    if (!logColumns.includes('cache_hit_tokens'))
      db.exec('ALTER TABLE request_logs ADD COLUMN cache_hit_tokens INTEGER NOT NULL DEFAULT 0');
    if (!logColumns.includes('reasoning_tokens'))
      db.exec('ALTER TABLE request_logs ADD COLUMN reasoning_tokens INTEGER NOT NULL DEFAULT 0');
    // Client correlation IDs plus the trace ID the upstream echoes back.
    for (const column of [
      'task_id TEXT',
      'session_id TEXT',
      'trace_id TEXT',
      'client_request_id TEXT',
      'logical_request_id TEXT',
      'client_attempt INTEGER',
      'upstream_request_id TEXT',
      'endpoint TEXT',
      'detail TEXT',
    ]) {
      if (!logColumns.includes(column.split(' ')[0]!))
        db.exec(`ALTER TABLE request_logs ADD COLUMN ${column}`);
    }
    const accountColumns = (db.pragma('table_info(accounts)') as { name: string }[]).map(
      (column) => column.name,
    );
    if (!accountColumns.includes('requests'))
      db.exec('ALTER TABLE accounts ADD COLUMN requests INTEGER NOT NULL DEFAULT 0');
    if (!accountColumns.includes('tokens'))
      db.exec('ALTER TABLE accounts ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0');
    if (!accountColumns.includes('legacy_label'))
      db.exec('ALTER TABLE accounts ADD COLUMN legacy_label TEXT');
    if (!accountColumns.includes('oauth_origin'))
      db.exec('ALTER TABLE accounts ADD COLUMN oauth_origin TEXT');
    // The account's upstream e-mail, decoded from the Keycloak access token so
    // the panel can tell two upstream identities apart.
    if (!accountColumns.includes('email')) db.exec('ALTER TABLE accounts ADD COLUMN email TEXT');
    // Credits the upstream charged for this account, so the panel can show
    // consumption per account instead of only per key.
    if (!accountColumns.includes('credits'))
      db.exec('ALTER TABLE accounts ADD COLUMN credits REAL NOT NULL DEFAULT 0');
    // When the upstream said this account is out of credits; the panel paints
    // the credit number red and any successful call clears it again.
    if (!accountColumns.includes('quota_exhausted_at'))
      db.exec('ALTER TABLE accounts ADD COLUMN quota_exhausted_at INTEGER');
    db.pragma('user_version = 10');
  })();
  return db;
}
