import { CredentialError, stripBearer, tokenClaims, type WorkBuddyCredential } from './credentials.js';
import { NoAvailableAccountsError } from './errors.js';
import type { IssuedCredential } from './upstream.js';
import type { Account, Store } from './store.js';

export type Refresher = (credential: WorkBuddyCredential) => Promise<WorkBuddyCredential>;

/**
 * Consecutive transient failures (5xx / 429 / network) tolerated before an
 * account is paused. Kept low on purpose: a client that already retries should
 * not be pinned to an account that keeps breaking.
 */
export const TRANSIENT_STRIKES_BEFORE_PAUSE = 3;

export type PoolAccountView = {
  id: string;
  name: string;
  note: string;
  source: string;
  user_id: string;
  domain: string;
  /** Account address decoded from the upstream access token (may be null). */
  email: string | null;
  ok: boolean;
  enabled: boolean;
  detail: string;
  needs_reauth: boolean;
  expires_at: number | null;
  quarantine_until?: number;
  consecutive_failures: number;
  requests: number;
  tokens: number;
  last_error: string | null;
  last_used_at: number | null;
  /** Client key that currently keeps this account, when key pinning is on. */
  bound_key_id: string | null;
  bound_key_name: string | null;
};

/**
 * Account scheduling over the SQLite account table. With `pool.accountBinding`
 * set to `key` (the default) a client key keeps one account for as long as that
 * account stays usable, so a long-running client session does not hop between
 * upstream identities; the assignment is dropped whenever the account is
 * disabled, signed out, quarantined or deleted. Without pinning, every request
 * picks an account on its own (round-robin or random). Transient failures also
 * quarantine an account with exponential backoff, and tokens are refreshed
 * before they expire. In-flight state is memory-only, which matches the
 * single-process design.
 */
export class Accounts {
  private cursor = 0;
  private refresher?: Refresher;
  private readonly refreshing = new Map<string, Promise<WorkBuddyCredential>>();

  constructor(
    private readonly store: Store,
    private readonly cooldownMs: () => number,
  ) {}

  setRefresher(refresh: Refresher): void {
    this.refresher = refresh;
  }

  get size(): number {
    return this.store.accounts().length;
  }

  list(): PoolAccountView[] {
    const now = Date.now();
    const owners = new Map(this.store.bindings().map((binding) => [binding.accountId, binding.apiKeyId]));
    const keyNames = new Map(this.store.keys().map((key) => [key.id, key.name]));
    return this.store.accounts().map((account) => ({
      id: account.id,
      name: account.name,
      note: account.note,
      source: account.source,
      user_id: account.userId,
      domain: account.domain,
      email: account.email,
      ok: account.enabled && !account.needsReauth && account.quarantinedUntil <= now,
      enabled: account.enabled,
      detail: !account.source
        ? '已导入凭据'
        : account.needsReauth
          ? '需要重新网页登录'
          : account.source === 'oauth'
            ? '网页登录'
            : account.source === 'import'
              ? '本机凭据导入'
              : account.source === 'env'
                ? '环境变量导入'
                : '手动令牌',
      needs_reauth: account.needsReauth,
      expires_at: account.expiresAt,
      ...(account.quarantinedUntil > now ? { quarantine_until: account.quarantinedUntil } : {}),
      consecutive_failures: account.consecutiveFailures,
      requests: account.requests,
      tokens: account.tokens,
      last_error: account.lastError,
      last_used_at: account.lastUsedAt,
      bound_key_id: owners.get(account.id) ?? null,
      bound_key_name: owners.get(account.id) ? (keyNames.get(owners.get(account.id)!) ?? null) : null,
    }));
  }

  /** Accounts that may serve a request right now. */
  private usable(): Account[] {
    const now = Date.now();
    return this.store
      .accounts()
      .filter((account) => account.enabled && !account.needsReauth && account.quarantinedUntil <= now);
  }

  /**
   * Selection order for a key that needs an account: unclaimed accounts first,
   * so spare capacity spreads client keys over distinct accounts, then the
   * configured round-robin or random order inside each group.
   */
  private order(accounts: Account[]): Account[] {
    // Never touch the cursor with an empty or single-element pool: `% 0` is NaN
    // and would pin the rotation to the first account forever.
    if (accounts.length < 2) return accounts;
    const claimed = new Set(this.store.bindings().map((binding) => binding.accountId));
    let ordered: Account[];
    if (this.store.settings().strategy === 'random') {
      ordered = [...accounts];
      for (let index = ordered.length - 1; index > 0; index--) {
        const swap = Math.floor(Math.random() * (index + 1));
        [ordered[index], ordered[swap]] = [ordered[swap]!, ordered[index]!];
      }
    } else {
      const start = this.cursor % accounts.length;
      this.cursor = (start + 1) % Math.max(accounts.length, 1);
      ordered = [...accounts.slice(start), ...accounts.slice(0, start)];
    }
    const free = ordered.filter((account) => !claimed.has(account.id));
    return free.length ? [...free, ...ordered.filter((account) => claimed.has(account.id))] : ordered;
  }

  /** The account this key keeps, while it can still serve requests. */
  private pinned(apiKeyId?: string): Account | undefined {
    if (!apiKeyId || this.store.settings().pool.accountBinding !== 'key') return undefined;
    const binding = this.store.binding(apiKeyId);
    if (!binding) return undefined;
    const account = this.store.account(binding.accountId);
    if (account && account.enabled && !account.needsReauth && account.quarantinedUntil <= Date.now())
      return account;
    // Disabled, signed out, quarantined or deleted: release so the next pick wins.
    this.store.releaseBindingForKey(apiKeyId);
    return undefined;
  }

  private assign(apiKeyId: string | undefined, accountId: string): void {
    if (!apiKeyId || this.store.settings().pool.accountBinding !== 'key') return;
    if (!this.store.hasKey(apiKeyId)) return;
    this.store.bindAccount(apiKeyId, accountId);
  }

  async getCredential(apiKeyId?: string): Promise<IssuedCredential> {
    const pinned = this.pinned(apiKeyId);
    if (pinned) {
      try {
        return await this.resolve(pinned.id);
      } catch {
        this.store.releaseBindingForAccount(pinned.id);
      }
    }
    const usable = this.usable();
    if (!usable.length) throw new NoAvailableAccountsError(this.store.availability());
    const candidates = this.order(usable);
    let lastError: unknown;
    for (const account of candidates) {
      try {
        const credential = await this.resolve(account.id);
        this.assign(apiKeyId, account.id);
        return credential;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError instanceof NoAvailableAccountsError) throw lastError;
    throw new NoAvailableAccountsError(this.store.availability());
  }

  private async resolve(accountId: string): Promise<IssuedCredential> {
    const stored = this.store.credential(accountId);
    if (!stored) throw new CredentialError('Account was removed; retry with the current session.');
    if (stored.expiresAt !== null && stored.expiresAt <= Date.now() + 60_000) {
      const refreshed = await this.refresh(accountId, this.store.upstreamCredential(accountId)!);
      return { ...refreshed, accountId, label: refreshed.userId };
    }
    return {
      accessToken: stripBearer(stored.accessToken),
      userId: stored.userId,
      domain: stored.domain,
      ...(stored.refreshToken ? { refreshToken: stored.refreshToken } : {}),
      ...(stored.expiresAt !== null ? { expiresAt: stored.expiresAt } : {}),
      ...(stored.refreshExpiresAt !== null ? { refreshExpiresAt: stored.refreshExpiresAt } : {}),
      accountId,
      label: stored.userId,
    };
  }

  /** Refresh one account's token, collapsing concurrent refreshes onto one request. */
  private refresh(accountId: string, current: WorkBuddyCredential): Promise<WorkBuddyCredential> {
    const inFlight = this.refreshing.get(accountId);
    if (inFlight) return inFlight;
    if (!current.refreshToken || !this.refresher) {
      this.store.markReauth(accountId, 'Account needs a new web login.');
      return Promise.reject(new CredentialError('Account needs a new web login.'));
    }
    const refresh = this.refresher;
    const task = (async () => {
      try {
        const credential = await refresh(current);
        if (credential.userId !== current.userId || credential.domain !== current.domain) {
          throw new CredentialError('Account identity changed during refresh.');
        }
        const claims = tokenClaims(credential.accessToken);
        this.store.saveCredential(accountId, {
          ...credential,
          ...(claims?.email ? { email: claims.email } : {}),
        });
        this.store.reportSuccess(accountId);
        return credential;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 401 || status === 403 || error instanceof CredentialError) {
          this.store.markReauth(accountId, 'Account needs a new web login.');
        } else {
          this.store.reportFailure(
            accountId,
            this.cooldownMs(),
            error instanceof Error ? error.message : undefined,
          );
        }
        throw new CredentialError('Account refresh failed; retry later or sign in again.');
      } finally {
        this.refreshing.delete(accountId);
      }
    })();
    this.refreshing.set(accountId, task);
    return task;
  }

  async refreshRejected(credential: IssuedCredential): Promise<IssuedCredential> {
    if (!credential.accountId)
      throw new CredentialError('Account changed or was removed; retry with the current session.');
    const stored = this.store.upstreamCredential(credential.accountId);
    if (!stored) throw new CredentialError('Account changed or was removed; retry with the current session.');
    const refreshed = await this.refresh(credential.accountId, stored);
    return { ...refreshed, accountId: credential.accountId, label: refreshed.userId };
  }

  reportFailure(credential: IssuedCredential, message?: string): void {
    if (!credential.accountId) return;
    this.reportFailureById(credential.accountId, message);
  }

  /** Quarantine an account when only its ID is known (e.g. a failed upstream call). */
  reportFailureById(accountId: string, message?: string): void {
    this.store.reportFailure(accountId, this.cooldownMs(), message);
  }

  /**
   * Report a transient upstream failure (5xx, 429, network). The first
   * `TRANSIENT_STRIKES_BEFORE_PAUSE` failures only count; after that the
   * account pauses and its binding is released, so the next retry can move on.
   */
  reportTransientFailure(accountId: string | undefined, message?: string): void {
    if (!accountId) return;
    this.store.reportTransientFailure(accountId, this.cooldownMs(), TRANSIENT_STRIKES_BEFORE_PAUSE, message);
  }

  reportSuccess(credential: IssuedCredential, tokens = 0): void {
    if (!credential.accountId) return;
    this.store.reportSuccess(credential.accountId);
    this.store.markUsed(credential.accountId, tokens);
  }

  invalidate(): void {}
  describe(): string {
    return `account pool (${this.size} accounts)`;
  }
}
