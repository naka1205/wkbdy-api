import type Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest, Vault } from './crypto.js';
import { defaultSettings, settingsSchema, type Settings } from './config.js';
import { storedModelSchema, type StoredModel } from './models.js';
import { EXPOSED_AGENT } from './catalog.js';
import type { AccountAvailability } from './errors.js';
import { stripBearer, type WorkBuddyCredential } from './credentials.js';

export const accountInput = z.object({
  name: z.string().trim().max(100).default(''),
  note: z.string().trim().max(64).default(''),
  source: z.enum(['manual', 'oauth', 'import', 'env']).default('manual'),
  accessToken: z.string().trim().min(1).max(65536),
  refreshToken: z.string().trim().max(65536).default(''),
  userId: z.string().trim().min(1).max(200),
  domain: z.string().trim().min(1).max(200).default('www.workbuddy.ai'),
  /** Upstream account address, decoded from the access token when available. */
  email: z.string().trim().max(200).default(''),
  /** Set for web-login accounts; required for token refresh. */
  oauthOrigin: z.string().url().optional(),
  expiresAt: z.number().positive().optional(),
  refreshExpiresAt: z.number().positive().optional(),
});
export const accountPatch = z
  .object({
    name: z.string().trim().max(100).optional(),
    note: z.string().trim().max(64).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export type AccountInput = z.input<typeof accountInput>;

/** Why an account is out of rotation; drives the cooldown policy per cause. */
export type CooldownReason = 'quota' | 'transient' | 'auth' | 'blocked';

/**
 * How far an empty balance reaches: WorkBuddy charges credits for paid models
 * and still answered "Credits exhausted" for a free one, so a failure on a free
 * model means the account cannot serve anything until it is topped up.
 */
export type QuotaScope = 'credits' | 'account';

export interface Account {
  id: string;
  name: string;
  note: string;
  source: string;
  userId: string;
  domain: string;
  email: string | null;
  oauthOrigin: string | null;
  expiresAt: number | null;
  refreshExpiresAt: number | null;
  enabled: boolean;
  needsReauth: boolean;
  quarantinedUntil: number;
  consecutiveFailures: number;
  requests: number;
  tokens: number;
  /** Credits the upstream charged for this account's requests. */
  credits: number;
  /** Set when the upstream reported this account out of credits. */
  quotaExhaustedAt: number | null;
  /** Why the account is out of rotation: quota, transient, auth or blocked. */
  cooldownReason: CooldownReason | null;
  /**
   * When a credit-consuming model may probe a quota-exhausted account again.
   * Free models ignore the quota gate, so this never blocks them.
   */
  quotaRetryAfter: number | null;
  /** `credits`: only paid models skip it. `account`: every model does. */
  quotaScope: QuotaScope | null;
  lastError: string | null;
  lastUsedAt: number | null;
  createdAt: string;
  hasRefreshToken: boolean;
}

export interface AccountCredential extends Account {
  accessToken: string;
  refreshToken: string;
}

export interface PublicApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** Sticky account assignment, when the pool is configured to pin keys. */
  accountId: string | null;
  accountName: string | null;
  boundAt: string | null;
}

export interface AccountBinding {
  apiKeyId: string;
  accountId: string;
  boundAt: string;
}

export interface RequestLogEntry {
  id?: number;
  requestId: string;
  timestamp: string;
  apiKeyId: string | null;
  apiKeyName: string | null;
  model: string;
  accountId: string | null;
  stream: boolean;
  status: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Prompt tokens served from the upstream prompt cache; 0 when unknown. */
  cacheHitTokens?: number;
  /** Reasoning tokens billed inside outputTokens; 0 when unknown. */
  reasoningTokens?: number;
  /** Credits the upstream charged (WorkBuddy `usage.credit`); 0 when unknown. */
  credits?: number;
  /** Correlation IDs sent by the client (see docs/retry-policy.md). */
  taskId?: string | null;
  sessionId?: string | null;
  traceId?: string | null;
  clientRequestId?: string | null;
  logicalRequestId?: string | null;
  clientAttempt?: number | null;
  /** Trace ID the upstream echoed back for this call. */
  upstreamRequestId?: string | null;
  error: string | null;
  /** Why the request failed, or what the gateway ignored while accepting it. */
  detail?: string | null;
  /** Path the client called, e.g. /v1/chat/completions. */
  endpoint?: string | null;
}

export interface LogQuery {
  limit?: number;
  offset?: number;
  model?: string;
  status?: 'success' | 'error';
  apiKeyId?: string;
  taskId?: string;
  logicalRequestId?: string;
}

type AccountRow = Record<string, any>;
type ModelRow = Record<string, any>;

function toAccount(row: AccountRow): Account {
  return {
    id: row.id,
    name: row.name,
    note: row.note ?? '',
    source: row.source ?? 'manual',
    userId: row.user_id,
    domain: row.domain,
    email: row.email ?? null,
    oauthOrigin: row.oauth_origin ?? null,
    expiresAt: row.expires_at ?? null,
    refreshExpiresAt: row.refresh_expires_at ?? null,
    enabled: row.enabled === 1,
    needsReauth: row.needs_reauth === 1,
    quarantinedUntil: row.quarantined_until ?? 0,
    consecutiveFailures: row.consecutive_failures ?? 0,
    requests: row.requests ?? 0,
    tokens: row.tokens ?? 0,
    credits: row.credits ?? 0,
    quotaExhaustedAt: row.quota_exhausted_at ?? null,
    cooldownReason: row.cooldown_reason ?? null,
    quotaRetryAfter: row.quota_retry_after ?? null,
    quotaScope: row.quota_scope ?? null,
    lastError: row.last_error ?? null,
    lastUsedAt: row.last_used_at ?? null,
    createdAt: row.created_at,
    hasRefreshToken: Boolean(row.refresh_token),
  };
}

const lastFour = (value: string) => (value.length > 4 ? value.slice(-4) : value);

/**
 * A credit-consuming model must skip an account whose balance ran out until
 * the probe window ends. Free models (`x0.00`) never consult this.
 */
export function isQuotaBlocked(account: Account, needsCredits: boolean, now: number = Date.now()): boolean {
  if (account.quotaExhaustedAt === null || (account.quotaRetryAfter ?? 0) <= now) return false;
  return account.quotaScope === 'account' || needsCredits;
}

/** When the account may serve the caller's model again. */
export function cooldownUntil(account: Account, needsCredits: boolean, now: number = Date.now()): number {
  return Math.max(
    account.quarantinedUntil,
    isQuotaBlocked(account, needsCredits, now) ? account.quotaRetryAfter! : 0,
  );
}

export class Store {
  readonly events = new EventEmitter();

  constructor(
    readonly db: Database.Database,
    private readonly vault: Vault,
  ) {
    this.events.setMaxListeners(1000);
  }

  meta<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }

  setMeta(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  }

  // ---- settings ----------------------------------------------------------

  settings(): Settings {
    return settingsSchema.parse({ ...defaultSettings, ...(this.meta('settings') ?? {}) });
  }

  saveSettings(value: unknown): Settings {
    const settings = settingsSchema.parse(value);
    this.setMeta('settings', settings);
    return settings;
  }

  /** Seed .env values once so a fresh install matches its environment. */
  seedSettings(seed: Partial<Settings>): Settings {
    if (!this.meta('settings'))
      this.setMeta('settings', settingsSchema.parse({ ...defaultSettings, ...seed }));
    return this.settings();
  }

  // ---- accounts ---------------------------------------------------------

  private accountRow(id: string): AccountRow | undefined {
    return this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;
  }

  accounts(): Account[] {
    return (this.db.prepare('SELECT * FROM accounts ORDER BY created_at').all() as AccountRow[]).map(
      toAccount,
    );
  }

  account(id: string): Account | undefined {
    const row = this.accountRow(id);
    return row ? toAccount(row) : undefined;
  }

  credential(id: string): AccountCredential | undefined {
    const row = this.accountRow(id);
    if (!row) return undefined;
    return {
      ...toAccount(row),
      accessToken: this.vault.decrypt(row.access_token),
      refreshToken: this.vault.decrypt(row.refresh_token),
    };
  }

  /** Every account the pool may schedule, including disabled ones (the pool filters). */
  credentials(): AccountCredential[] {
    return this.accounts()
      .map((account) => this.credential(account.id))
      .filter((credential): credential is AccountCredential => credential !== undefined);
  }

  /** Credential in the upstream-facing shape (absent/null fields dropped). */
  upstreamCredential(id: string): WorkBuddyCredential | undefined {
    const credential = this.credential(id);
    if (!credential) return undefined;
    return {
      accessToken: credential.accessToken,
      userId: credential.userId,
      domain: credential.domain,
      ...(credential.oauthOrigin ? { oauthOrigin: credential.oauthOrigin } : {}),
      ...(credential.refreshToken ? { refreshToken: credential.refreshToken } : {}),
      ...(credential.expiresAt !== null ? { expiresAt: credential.expiresAt } : {}),
      ...(credential.refreshExpiresAt !== null ? { refreshExpiresAt: credential.refreshExpiresAt } : {}),
    };
  }

  /**
   * Insert or refresh an account. Identity is the upstream user, so a
   * re-import of the same user updates tokens instead of duplicating rows.
   */
  upsertAccount(input: AccountInput): Account {
    const parsed = accountInput.parse(input);
    const accessToken = stripBearer(parsed.accessToken);
    const tokenHash = digest(`${parsed.domain}:${accessToken}`);
    const now = new Date().toISOString();
    const existing =
      (this.db.prepare('SELECT * FROM accounts WHERE token_hash = ?').get(tokenHash) as
        AccountRow | undefined) ??
      (this.db
        .prepare('SELECT * FROM accounts WHERE domain = ? AND user_id = ?')
        .get(parsed.domain, parsed.userId) as AccountRow | undefined);
    if (existing) {
      this.db
        .prepare(
          `UPDATE accounts SET access_token=?, refresh_token=?, token_hash=?, user_id=?, domain=?,
             oauth_origin=COALESCE(NULLIF(?,''), oauth_origin),
             source=?, expires_at=?, refresh_expires_at=?, enabled=1, needs_reauth=0, quarantined_until=0,
             consecutive_failures=0, last_error=NULL, quota_exhausted_at=NULL,
             quota_retry_after=NULL, cooldown_reason=NULL,
             email=COALESCE(NULLIF(?,''), email),
             name=CASE WHEN ? <> '' THEN ? ELSE name END,
             note=CASE WHEN ? <> '' THEN ? ELSE note END
           WHERE id=?`,
        )
        .run(
          this.vault.encrypt(accessToken),
          parsed.refreshToken ? this.vault.encrypt(parsed.refreshToken) : existing.refresh_token,
          tokenHash,
          parsed.userId,
          parsed.domain,
          parsed.oauthOrigin ?? '',
          parsed.source,
          parsed.expiresAt ?? null,
          parsed.refreshExpiresAt ?? null,
          parsed.email,
          parsed.name,
          parsed.name,
          parsed.note,
          parsed.note,
          existing.id,
        );
      return this.account(existing.id)!;
    }
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO accounts (id,name,note,source,access_token,refresh_token,token_hash,user_id,domain,email,
           oauth_origin,expires_at,refresh_expires_at,enabled,needs_reauth,quarantined_until,consecutive_failures,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,0,0,0,?)`,
      )
      .run(
        id,
        parsed.name || defaultAccountName(parsed.domain, parsed.userId),
        parsed.note,
        parsed.source,
        this.vault.encrypt(accessToken),
        parsed.refreshToken ? this.vault.encrypt(parsed.refreshToken) : '',
        tokenHash,
        parsed.userId,
        parsed.domain,
        parsed.email || null,
        parsed.oauthOrigin ?? null,
        parsed.expiresAt ?? null,
        parsed.refreshExpiresAt ?? null,
        now,
      );
    return this.account(id)!;
  }

  patchAccount(id: string, patch: unknown): Account | undefined {
    const parsed = accountPatch.parse(patch);
    const sets: string[] = [];
    const values: unknown[] = [];
    if (parsed.name !== undefined) {
      sets.push('name=?');
      values.push(parsed.name);
    }
    if (parsed.note !== undefined) {
      sets.push('note=?');
      values.push(parsed.note);
    }
    if (parsed.enabled !== undefined) {
      sets.push('enabled=?');
      values.push(parsed.enabled ? 1 : 0);
      if (parsed.enabled) {
        // Re-enabling is an operator statement that the account is usable
        // again, so clear the "out of credits" flag too.
        sets.push('quarantined_until=0', 'consecutive_failures=0', 'quota_exhausted_at=NULL');
        sets.push('quota_retry_after=NULL', 'quota_scope=NULL', 'cooldown_reason=NULL');
      }
    }
    if (!sets.length) return this.account(id);
    values.push(id);
    const result = this.db
      .prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id=?`)
      .run(...(values as never[]));
    if (result.changes && parsed.enabled === false) this.releaseBindingForAccount(id);
    return result.changes ? this.account(id) : undefined;
  }

  /** Persist a refreshed credential without touching scheduling counters. */
  saveCredential(
    id: string,
    credential: {
      accessToken: string;
      refreshToken?: string;
      expiresAt?: number;
      refreshExpiresAt?: number;
      /** Backfills the account address for rows created before email tracking. */
      email?: string | null;
    },
  ): Account | undefined {
    if (!this.accountRow(id)) return undefined;
    this.db
      .prepare(
        `UPDATE accounts SET access_token=?, token_hash=?, refresh_token=COALESCE(NULLIF(?,''), refresh_token),
           expires_at=?, refresh_expires_at=?, needs_reauth=0, last_error=NULL,
           email=COALESCE(NULLIF(?,''), email) WHERE id=?`,
      )
      .run(
        this.vault.encrypt(stripBearer(credential.accessToken)),
        digest(`${this.account(id)!.domain}:${stripBearer(credential.accessToken)}`),
        credential.refreshToken ? this.vault.encrypt(credential.refreshToken) : '',
        credential.expiresAt ?? null,
        credential.refreshExpiresAt ?? null,
        credential.email ?? '',
        id,
      );
    return this.account(id);
  }

  /** Store the account address decoded from its token; no-op for empty values. */
  setAccountEmail(id: string, email: string | null | undefined): void {
    if (!email) return;
    this.db.prepare('UPDATE accounts SET email=? WHERE id=?').run(email, id);
  }

  removeAccount(id: string): boolean {
    return this.db.transaction(() => {
      this.releaseBindingForAccount(id);
      return this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id).changes > 0;
    })();
  }

  markUsed(id: string, tokens = 0, credits = 0): void {
    this.db
      .prepare(
        'UPDATE accounts SET last_used_at=?, requests=requests+1, tokens=tokens+?, credits=credits+? WHERE id=?',
      )
      .run(Date.now(), tokens, credits, id);
  }

  reportSuccess(id: string): void {
    this.db
      .prepare(
        `UPDATE accounts SET consecutive_failures=0, quarantined_until=0, last_error=NULL,
           quota_exhausted_at=NULL, quota_retry_after=NULL, cooldown_reason=NULL WHERE id=?`,
      )
      .run(id);
  }

  /**
   * The upstream says this account is out of credits. That is *not* a broken
   * account: nothing about the credential is wrong, the balance is empty, so
   * the row is parked for a probe window instead of collecting failure
   * strikes. A topped-up account comes back on its own.
   *
   * `accountWide` records what the upstream actually told us: WorkBuddy
   * answers code 14018 for free (`x0.00`) models too, so a quota reply seen on
   * a free model parks the account for every model; a reply seen on a paid
   * model parks it for the credit-consuming ones only. The scope is stored so
   * a later probe that succeeds narrows it back.
   */
  markQuotaExhausted(
    id: string,
    retryMs: number,
    error?: string,
    options: { model?: string; accountWide?: boolean } = {},
  ): void {
    const now = Date.now();
    const detail = error ?? 'Upstream quota or balance is exhausted.';
    const { model } = options;
    this.db
      .prepare(
        `UPDATE accounts SET quota_exhausted_at=?, quota_retry_after=?, cooldown_reason='quota',
           quota_scope=?, last_error=? WHERE id=?`,
      )
      .run(
        now,
        now + retryMs,
        options.accountWide ? 'account' : 'credits',
        (model ? `${detail} (model: ${model})` : detail).slice(0, 300),
        id,
      );
  }

  /**
   * Upstream risk control blocked this account. It cannot recover by waiting,
   * so it leaves the rotation until an operator re-enables it.
   */
  disableAccount(id: string, error?: string): void {
    this.db
      .prepare("UPDATE accounts SET enabled=0, cooldown_reason='blocked', last_error=? WHERE id=?")
      .run((error ?? 'Upstream blocked this account.').slice(0, 300), id);
    this.releaseBindingForAccount(id);
  }

  reportFailure(id: string, cooldownMs: number, error?: string): void {
    const account = this.account(id);
    if (!account) return;
    const failures = account.consecutiveFailures + 1;
    const backoff = Math.min(cooldownMs * 2 ** Math.min(failures - 1, 10), 30 * 60_000);
    this.db
      .prepare(
        `UPDATE accounts SET consecutive_failures=?, quarantined_until=?, cooldown_reason='transient',
           last_error=? WHERE id=?`,
      )
      .run(failures, Date.now() + backoff, error?.slice(0, 300) ?? account.lastError, id);
    // A quarantined account cannot serve its key, so the assignment is dropped
    // and the next request picks a healthy account instead of failing.
    this.releaseBindingForAccount(id);
  }

  /**
   * Record a transient upstream failure. Below `strikesBeforePause` the account
   * keeps serving (a single blip must not move a pinned client); from there on
   * it is quarantined with the same exponential backoff as a hard failure.
   */
  reportTransientFailure(id: string, cooldownMs: number, strikesBeforePause: number, error?: string): void {
    const account = this.account(id);
    if (!account) return;
    const failures = account.consecutiveFailures + 1;
    if (strikesBeforePause <= 0 || failures >= strikesBeforePause) {
      this.reportFailure(id, cooldownMs, error);
      return;
    }
    this.db
      .prepare(
        "UPDATE accounts SET consecutive_failures=?, cooldown_reason='transient', last_error=? WHERE id=?",
      )
      .run(failures, error?.slice(0, 300) ?? account.lastError, id);
  }

  markReauth(id: string, error?: string): void {
    this.db
      .prepare("UPDATE accounts SET needs_reauth=1, cooldown_reason='auth', last_error=? WHERE id=?")
      .run(error?.slice(0, 300) ?? 'Account needs a new web login.', id);
    this.releaseBindingForAccount(id);
  }

  /**
   * Pool state for the client-facing error. `needsCredits` expands the pool
   * view to the way a credit-consuming model sees it: accounts whose balance
   * ran out are unavailable there, while free models can still use them.
   */
  availability(needsCredits = false): AccountAvailability {
    const now = Date.now();
    const accounts = this.accounts();
    const disabled = accounts.filter((account) => !account.enabled).length;
    const needsReauth = accounts.filter((account) => account.enabled && account.needsReauth).length;
    const live = accounts.filter((account) => account.enabled && !account.needsReauth);
    const cooling = live.filter((account) => account.quarantinedUntil > now);
    const quotaBlocked = live.filter(
      (account) => isQuotaBlocked(account, needsCredits, now) && account.quarantinedUntil <= now,
    );
    const parked = [...cooling, ...quotaBlocked];
    const retryAfterSeconds = parked.length
      ? Math.max(
          1,
          Math.ceil(
            (Math.min(...parked.map((account) => cooldownUntil(account, needsCredits, now))) - now) / 1000,
          ),
        )
      : undefined;
    return {
      total: accounts.length,
      disabled,
      needsReauth,
      coolingDown: cooling.length,
      quotaBlocked: quotaBlocked.length,
      available: accounts.length - disabled - needsReauth - parked.length,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    };
  }

  // ---- client API keys --------------------------------------------------

  keys(): PublicApiKey[] {
    const rows = this.db
      .prepare(
        `SELECT k.*, b.account_id AS bound_account_id, b.bound_at AS bound_at, a.name AS bound_account_name
         FROM api_keys k
         LEFT JOIN account_bindings b ON b.api_key_id = k.id
         LEFT JOIN accounts a ON a.id = b.account_id
         ORDER BY k.created_at`,
      )
      .all() as AccountRow[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at ?? null,
      accountId: row.bound_account_id ?? null,
      accountName: row.bound_account_name ?? null,
      boundAt: row.bound_at ?? null,
    }));
  }

  // ---- sticky account assignments ---------------------------------------

  bindings(): AccountBinding[] {
    return this.db
      .prepare(
        'SELECT api_key_id AS apiKeyId, account_id AS accountId, bound_at AS boundAt FROM account_bindings',
      )
      .all() as AccountBinding[];
  }

  binding(apiKeyId: string): AccountBinding | undefined {
    return this.db
      .prepare(
        'SELECT api_key_id AS apiKeyId, account_id AS accountId, bound_at AS boundAt FROM account_bindings WHERE api_key_id=?',
      )
      .get(apiKeyId) as AccountBinding | undefined;
  }

  /** Assign (or re-assign) the account a client key keeps using. */
  bindAccount(apiKeyId: string, accountId: string): void {
    this.db
      .prepare(
        `INSERT INTO account_bindings (api_key_id, account_id, bound_at) VALUES (?,?,?)
         ON CONFLICT(api_key_id) DO UPDATE SET account_id=excluded.account_id, bound_at=excluded.bound_at`,
      )
      .run(apiKeyId, accountId, new Date().toISOString());
  }

  releaseBindingForAccount(accountId: string): void {
    this.db.prepare('DELETE FROM account_bindings WHERE account_id=?').run(accountId);
  }

  releaseBindingForKey(apiKeyId: string): void {
    this.db.prepare('DELETE FROM account_bindings WHERE api_key_id=?').run(apiKeyId);
  }

  boundKeyId(accountId: string): string | undefined {
    const row = this.db
      .prepare('SELECT api_key_id AS apiKeyId FROM account_bindings WHERE account_id=? ORDER BY bound_at')
      .get(accountId) as { apiKeyId: string } | undefined;
    return row?.apiKeyId;
  }

  addKey(name: string, key?: string): { key: string; record: PublicApiKey } {
    // 32 random bytes of base64url: 43 characters, same entropy class as sk- keys.
    const secret = key ?? `sk-wk-${randomBytes(32).toString('base64url')}`;
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare('INSERT INTO api_keys (id,name,prefix,hash,created_at) VALUES (?,?,?,?,?)')
      .run(id, name.slice(0, 100) || 'API key', secret.slice(0, 12), digest(secret), now);
    return { key: secret, record: this.keys().find((entry) => entry.id === id)! };
  }

  hasKey(id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM api_keys WHERE id=?').get(id));
  }

  removeKey(id: string): boolean {
    return this.db.transaction(() => {
      this.releaseBindingForKey(id);
      return this.db.prepare('DELETE FROM api_keys WHERE id = ?').run(id).changes > 0;
    })();
  }

  authenticateKey(key: string): string | null {
    if (!key) return null;
    const row = this.db.prepare('SELECT id FROM api_keys WHERE hash = ?').get(digest(key)) as
      { id: string } | undefined;
    if (!row) return null;
    this.db.prepare('UPDATE api_keys SET last_used_at=? WHERE id=?').run(new Date().toISOString(), row.id);
    return row.id;
  }

  // ---- models -----------------------------------------------------------
  //
  // The product catalog is normalised into tables: one row per model plus child
  // tables for the capability lists, and an agent whitelist that decides which
  // models clients may see. Panel state (enabled, selected context window) lives
  // on the model row and survives catalog imports.

  private modelRow(id: string): ModelRow | undefined {
    return this.db.prepare('SELECT * FROM models WHERE id = ?').get(id) as ModelRow | undefined;
  }

  private modelFromRow(row: ModelRow): StoredModel {
    const lengths = (
      this.db
        .prepare('SELECT length FROM model_context_lengths WHERE model_id = ? ORDER BY position, length')
        .all(row.id) as { length: number }[]
    ).map((entry) => entry.length);
    const efforts = (
      this.db
        .prepare('SELECT effort FROM model_reasoning_efforts WHERE model_id = ? ORDER BY position, effort')
        .all(row.id) as { effort: string }[]
    ).map((entry) => entry.effort);
    const reasoning = {
      ...(row.reasoning_can_disable_thinking === null
        ? {}
        : { canDisableThinking: row.reasoning_can_disable_thinking === 1 }),
      ...(row.reasoning_default_effort ? { defaultEffort: row.reasoning_default_effort } : {}),
      ...(row.reasoning_effort ? { effort: row.reasoning_effort } : {}),
      ...(row.reasoning_summary ? { summary: row.reasoning_summary } : {}),
      ...(efforts.length ? { supportedEfforts: efforts } : {}),
    };
    return storedModelSchema.parse({
      id: row.id,
      object: 'model',
      created: 0,
      owned_by: 'workbuddy',
      enabled: row.enabled === 1,
      ...(row.selected_context_window !== null ? { context_window: row.selected_context_window } : {}),
      x_workbuddy: {
        name: row.name || undefined,
        description: row.description ?? undefined,
        is_default: row.is_default === 1,
        max_input_tokens: row.max_input_tokens ?? undefined,
        max_output_tokens: row.max_output_tokens ?? undefined,
        supports_images: row.supports_images === 1,
        supports_tool_call: row.supports_tool_call === 1,
        supports_reasoning: row.supports_reasoning === 1,
        only_reasoning: row.only_reasoning === 1,
        ...(Object.keys(reasoning).length ? { reasoning } : {}),
        ...(lengths.length || row.context_default_length !== null
          ? {
              context_window: {
                defaultLength: row.context_default_length ?? lengths[0] ?? 0,
                supportedLengths: lengths,
              },
            }
          : {}),
        credits: row.credits ?? undefined,
        temperature: row.temperature ?? undefined,
      },
    });
  }

  models(): StoredModel[] {
    const rows = this.db.prepare('SELECT * FROM models ORDER BY position, id').all() as ModelRow[];
    return rows.map((row) => this.modelFromRow(row));
  }

  /** Models the given agent whitelists, in catalog order. */
  modelsForAgent(agent = EXPOSED_AGENT): StoredModel[] {
    const rows = this.db
      .prepare(
        `SELECT models.* FROM models
           JOIN agent_models ON agent_models.model_id = models.id AND agent_models.agent = ?
         ORDER BY agent_models.position, models.position`,
      )
      .all(agent) as ModelRow[];
    return rows.map((row) => this.modelFromRow(row));
  }

  /** Models exposed to clients: whitelisted by the agent and enabled in the panel. */
  exposedModels(agent = EXPOSED_AGENT): StoredModel[] {
    return this.modelsForAgent(agent).filter((model) => model.enabled);
  }

  model(id: string): StoredModel | undefined {
    const row = this.modelRow(id);
    return row ? this.modelFromRow(row) : undefined;
  }

  saveModel(value: unknown, position = 0): StoredModel {
    const model = storedModelSchema.parse(value);
    const now = new Date().toISOString();
    const meta = model.x_workbuddy;
    const context = meta.context_window;
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO models (id,name,description,credits,is_default,max_input_tokens,max_output_tokens,
             temperature,supports_images,supports_tool_call,supports_reasoning,only_reasoning,
             reasoning_can_disable_thinking,reasoning_default_effort,reasoning_effort,reasoning_summary,
             context_default_length,enabled,selected_context_window,position,synced_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             name=excluded.name, description=excluded.description, credits=excluded.credits,
             is_default=excluded.is_default, max_input_tokens=excluded.max_input_tokens,
             max_output_tokens=excluded.max_output_tokens, temperature=excluded.temperature,
             supports_images=excluded.supports_images, supports_tool_call=excluded.supports_tool_call,
             supports_reasoning=excluded.supports_reasoning, only_reasoning=excluded.only_reasoning,
             reasoning_can_disable_thinking=excluded.reasoning_can_disable_thinking,
             reasoning_default_effort=excluded.reasoning_default_effort, reasoning_effort=excluded.reasoning_effort,
             reasoning_summary=excluded.reasoning_summary, context_default_length=excluded.context_default_length,
             enabled=excluded.enabled, selected_context_window=excluded.selected_context_window,
             position=excluded.position, synced_at=excluded.synced_at, updated_at=excluded.updated_at`,
        )
        .run(
          model.id,
          meta.name ?? '',
          meta.description ?? null,
          meta.credits ?? null,
          meta.is_default ? 1 : 0,
          meta.max_input_tokens ?? null,
          meta.max_output_tokens ?? null,
          meta.temperature ?? null,
          meta.supports_images ? 1 : 0,
          meta.supports_tool_call ? 1 : 0,
          meta.supports_reasoning ? 1 : 0,
          meta.only_reasoning ? 1 : 0,
          meta.reasoning?.canDisableThinking === undefined ? null : meta.reasoning.canDisableThinking ? 1 : 0,
          meta.reasoning?.defaultEffort ?? null,
          meta.reasoning?.effort ?? null,
          meta.reasoning?.summary ?? null,
          context?.defaultLength ?? null,
          model.enabled ? 1 : 0,
          model.context_window ?? null,
          position,
          now,
          now,
        );
      this.db.prepare('DELETE FROM model_context_lengths WHERE model_id = ?').run(model.id);
      for (const [index, length] of (context?.supportedLengths ?? []).entries()) {
        this.db
          .prepare('INSERT OR REPLACE INTO model_context_lengths (model_id,length,position) VALUES (?,?,?)')
          .run(model.id, length, index);
      }
      this.db.prepare('DELETE FROM model_reasoning_efforts WHERE model_id = ?').run(model.id);
      for (const [index, effort] of (meta.reasoning?.supportedEfforts ?? []).entries()) {
        this.db
          .prepare('INSERT OR REPLACE INTO model_reasoning_efforts (model_id,effort,position) VALUES (?,?,?)')
          .run(model.id, effort, index);
      }
    })();
    return model;
  }

  /**
   * Replace the stored catalog with a freshly parsed one. Panel state is
   * preserved for models that still exist upstream; models that disappeared are
   * removed together with their child rows and agent references.
   */
  importCatalog(catalog: {
    models: StoredModel[];
    agents: Array<{ name: string; models: string[]; modelTags?: string[] }>;
    endpoint?: string;
  }): { added: number; updated: number; removed: number } {
    return this.db.transaction(() => {
      const current = new Map(this.models().map((model) => [model.id, model]));
      const incoming = new Map(catalog.models.map((model) => [model.id, model]));
      let added = 0;
      let updated = 0;
      let removed = 0;
      for (const id of current.keys()) {
        if (incoming.has(id)) continue;
        this.db.prepare('DELETE FROM models WHERE id = ?').run(id);
        removed += 1;
      }
      let position = 0;
      for (const model of catalog.models) {
        const existing = current.get(model.id);
        this.saveModel(
          {
            ...model,
            enabled: existing?.enabled ?? model.enabled,
            ...(existing?.context_window !== undefined ? { context_window: existing.context_window } : {}),
          },
          position++,
        );
        if (existing) updated += 1;
        else added += 1;
      }
      this.db.prepare('DELETE FROM agents').run();
      for (const [index, agent] of catalog.agents.entries()) {
        this.db.prepare('INSERT INTO agents (name,position) VALUES (?,?)').run(agent.name, index);
        for (const [order, modelId] of agent.models.entries()) {
          this.db
            .prepare('INSERT OR IGNORE INTO agent_models (agent,model_id,position) VALUES (?,?,?)')
            .run(agent.name, modelId, order);
        }
        for (const [order, tag] of (agent.modelTags ?? []).entries()) {
          this.db
            .prepare('INSERT OR IGNORE INTO agent_tags (agent,tag,position) VALUES (?,?,?)')
            .run(agent.name, tag, order);
        }
      }
      if (catalog.endpoint !== undefined) this.setMeta('catalogEndpoint', catalog.endpoint);
      this.setMeta('catalogSyncedAt', new Date().toISOString());
      return { added, updated, removed };
    })();
  }

  patchModel(id: string, patch: unknown): StoredModel | undefined {
    const model = this.model(id);
    if (!model) return undefined;
    const parsed = z
      .object({
        enabled: z.boolean().optional(),
        context_window: z.number().int().positive().nullable().optional(),
      })
      .strict()
      .parse(patch);
    const next: StoredModel = { ...model };
    if (parsed.enabled !== undefined) next.enabled = parsed.enabled;
    if (parsed.context_window === null) delete next.context_window;
    else if (parsed.context_window !== undefined) next.context_window = parsed.context_window;
    return this.saveModel(next, this.modelPosition(id));
  }

  private modelPosition(id: string): number {
    const row = this.db.prepare('SELECT position FROM models WHERE id = ?').get(id) as
      { position: number } | undefined;
    return row?.position ?? 0;
  }

  /** Catalog metadata for the panel. */
  catalog(): {
    endpoint: string | null;
    syncedAt: string | null;
    agents: Array<{ name: string; models: string[]; modelTags: string[] }>;
  } {
    const agents = (
      this.db.prepare('SELECT name FROM agents ORDER BY position, name').all() as { name: string }[]
    ).map((entry) => ({
      name: entry.name,
      models: (
        this.db
          .prepare('SELECT model_id FROM agent_models WHERE agent = ? ORDER BY position')
          .all(entry.name) as { model_id: string }[]
      ).map((model) => model.model_id),
      modelTags: (
        this.db.prepare('SELECT tag FROM agent_tags WHERE agent = ? ORDER BY position').all(entry.name) as {
          tag: string;
        }[]
      ).map((tag) => tag.tag),
    }));
    return {
      endpoint: this.meta<string>('catalogEndpoint'),
      syncedAt: this.meta<string>('catalogSyncedAt'),
      agents,
    };
  }

  // ---- request logs -----------------------------------------------------

  recordLog(entry: RequestLogEntry): void {
    this.db
      .prepare(
        `INSERT INTO request_logs (request_id,timestamp,api_key_id,api_key_name,model,account_id,stream,status,
           duration_ms,input_tokens,output_tokens,total_tokens,cache_hit_tokens,reasoning_tokens,credits,
           task_id,session_id,trace_id,client_request_id,logical_request_id,client_attempt,upstream_request_id,
           error,endpoint,detail)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        entry.requestId,
        entry.timestamp,
        entry.apiKeyId,
        entry.apiKeyName,
        entry.model,
        entry.accountId,
        entry.stream ? 1 : 0,
        entry.status,
        entry.durationMs,
        entry.inputTokens,
        entry.outputTokens,
        entry.totalTokens,
        entry.cacheHitTokens ?? 0,
        entry.reasoningTokens ?? 0,
        entry.credits ?? 0,
        entry.taskId ?? null,
        entry.sessionId ?? null,
        entry.traceId ?? null,
        entry.clientRequestId ?? null,
        entry.logicalRequestId ?? null,
        entry.clientAttempt ?? null,
        entry.upstreamRequestId ?? null,
        entry.error,
        entry.endpoint ?? null,
        entry.detail ?? null,
      );
    this.events.emit('log', entry);
  }

  logs(query: LogQuery = {}): { total: number; entries: RequestLogEntry[] } {
    const filters: string[] = [];
    const values: unknown[] = [];
    if (query.model) {
      filters.push('model = ?');
      values.push(query.model);
    }
    if (query.status === 'success') filters.push('status < 400');
    if (query.status === 'error') filters.push('status >= 400');
    if (query.apiKeyId) {
      filters.push('api_key_id = ?');
      values.push(query.apiKeyId);
    }
    // Correlation lookups always stay inside one key, so two clients using the
    // same task ID cannot see each other's rows.
    if (query.taskId) {
      filters.push('task_id = ?');
      values.push(query.taskId);
    }
    if (query.logicalRequestId) {
      filters.push('logical_request_id = ?');
      values.push(query.logicalRequestId);
    }
    const where = filters.length ? ` WHERE ${filters.join(' AND ')}` : '';
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS total FROM request_logs${where}`).get(...(values as never[])) as {
        total: number;
      }
    ).total;
    const rows = this.db
      .prepare(`SELECT * FROM request_logs${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...(values as never[]), query.limit ?? 50, query.offset ?? 0) as AccountRow[];
    return {
      total,
      entries: rows.map((row) => ({
        id: row.id,
        requestId: row.request_id,
        timestamp: row.timestamp,
        apiKeyId: row.api_key_id ?? null,
        apiKeyName: row.api_key_name ?? null,
        model: row.model,
        accountId: row.account_id ?? null,
        stream: row.stream === 1,
        status: row.status,
        durationMs: row.duration_ms,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        totalTokens: row.total_tokens,
        cacheHitTokens: row.cache_hit_tokens ?? 0,
        reasoningTokens: row.reasoning_tokens ?? 0,
        credits: row.credits ?? 0,
        taskId: row.task_id ?? null,
        sessionId: row.session_id ?? null,
        traceId: row.trace_id ?? null,
        clientRequestId: row.client_request_id ?? null,
        logicalRequestId: row.logical_request_id ?? null,
        clientAttempt: row.client_attempt ?? null,
        upstreamRequestId: row.upstream_request_id ?? null,
        error: row.error ?? null,
        detail: row.detail ?? null,
        endpoint: row.endpoint ?? null,
      })),
    };
  }

  stats(): {
    requests24h: number;
    errors24h: number;
    tokens24h: number;
    credits24h: number;
    /** Prompt tokens served from the upstream cache in the last 24h. */
    cacheHitTokens24h: number;
    perModel: Array<{ model: string; requests: number; tokens: number }>;
    latency: { p50: number | null; p95: number | null };
    daily: Array<{ date: string; requests: number; tokens: number }>;
  } {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS requests, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
                COALESCE(SUM(total_tokens), 0) AS tokens, COALESCE(SUM(credits), 0) AS credits,
                COALESCE(SUM(cache_hit_tokens), 0) AS cache_hits
         FROM request_logs WHERE timestamp >= ?`,
      )
      .get(since) as {
      requests: number;
      errors: number | null;
      tokens: number;
      credits: number;
      cache_hits: number;
    };
    const perModel = this.db
      .prepare(
        `SELECT model, COUNT(*) AS requests, COALESCE(SUM(total_tokens),0) AS tokens
         FROM request_logs WHERE timestamp >= ? GROUP BY model ORDER BY requests DESC LIMIT 20`,
      )
      .all(since) as Array<{ model: string; requests: number; tokens: number }>;
    const durations = (
      this.db
        .prepare('SELECT duration_ms FROM request_logs WHERE timestamp >= ? ORDER BY duration_ms')
        .all(since) as {
        duration_ms: number;
      }[]
    ).map((row) => row.duration_ms);
    const percentile = (value: number) =>
      durations.length
        ? (durations[Math.min(durations.length - 1, Math.floor(durations.length * value))] ?? null)
        : null;
    const week = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const daily = (
      this.db
        .prepare(
          `SELECT substr(timestamp, 1, 10) AS date, COUNT(*) AS requests, COALESCE(SUM(total_tokens), 0) AS tokens
           FROM request_logs WHERE timestamp >= ? GROUP BY date ORDER BY date`,
        )
        .all(week) as Array<{ date: string; requests: number; tokens: number }>
    ).map((row) => ({ date: row.date, requests: row.requests, tokens: row.tokens }));
    return {
      requests24h: totals.requests,
      errors24h: totals.errors ?? 0,
      tokens24h: totals.tokens,
      credits24h: totals.credits,
      cacheHitTokens24h: totals.cache_hits,
      perModel,
      latency: { p50: percentile(0.5), p95: percentile(0.95) },
      daily,
    };
  }

  clearLogs(): void {
    this.db.prepare('DELETE FROM request_logs').run();
  }

  pruneLogs(settings: Settings): number {
    const cutoff = new Date(Date.now() - settings.logging.retentionDays * 86_400_000).toISOString();
    const byAge = this.db.prepare('DELETE FROM request_logs WHERE timestamp < ?').run(cutoff).changes;
    const byCount = this.db
      .prepare(
        'DELETE FROM request_logs WHERE id NOT IN (SELECT id FROM request_logs ORDER BY id DESC LIMIT ?)',
      )
      .run(settings.logging.maxEntries).changes;
    return byAge + byCount;
  }
}

function defaultAccountName(domain: string, userId: string): string {
  const host = domain.replace(/^https?:\/\//, '').split('/')[0] ?? domain;
  return `WorkBuddy · ${host} · …${lastFour(userId)}`;
}
