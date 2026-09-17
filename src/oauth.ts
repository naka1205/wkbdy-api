import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { WorkBuddyCredential } from './credentials.js';

export const AUTH_ORIGIN = 'https://www.workbuddy.ai';
const AUTH_ORIGINS = new Set([AUTH_ORIGIN, 'https://www.codebuddy.ai']);
const secret = z
  .string()
  .min(1)
  .max(32_768)
  .refine((s) => !/[\r\n]/.test(s));
const authSchema = z.object({
  accessToken: secret,
  refreshToken: secret.optional(),
  tokenType: z.string().optional(),
  domain: z.string().optional(),
  expiresIn: z.number().positive().optional(),
  refreshExpiresIn: z.number().nonnegative().optional(),
  expiresAt: z.number().positive().optional(),
  refreshExpiresAt: z.number().positive().optional(),
});
const accountSchema = z.object({ uid: secret });
const active = new Set(['starting', 'pending', 'token_received', 'account_received']);
export type LoginPhase =
  | 'starting'
  | 'pending'
  | 'token_received'
  | 'account_received'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';
export type LoginStatus = {
  id: string;
  status: LoginPhase;
  expires_at: number;
  account_label?: string;
  error?: string;
};
type Transaction = LoginStatus & {
  owner: string;
  controller: AbortController;
  expiryTimer: ReturnType<typeof setTimeout>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
};

export class OAuthError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(code);
    this.name = 'OAuthError';
  }
}

export type OAuthBrokerOptions = {
  onComplete: (credential: WorkBuddyCredential, note?: string) => Promise<string>;
  /** Static value or getter, so runtime settings changes take effect immediately. */
  userAgent?: string | (() => string);
  fetchFn?: typeof fetch;
  pollIntervalMs?: number;
  loginTimeoutMs?: number;
  requestTimeoutMs?: number;
};

export class OAuthBroker {
  private readonly transactions = new Map<string, Transaction>();
  private readonly fetchFn: typeof fetch;
  private readonly pollInterval: number;
  private readonly loginTimeout: number;
  private readonly requestTimeout: number;
  private closed = false;

  constructor(private readonly opts: OAuthBrokerOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.pollInterval = opts.pollIntervalMs ?? 1_000;
    this.loginTimeout = opts.loginTimeoutMs ?? 300_000;
    this.requestTimeout = opts.requestTimeoutMs ?? 10_000;
  }

  private userAgent(): string {
    const configured = this.opts.userAgent;
    const value = typeof configured === 'function' ? configured() : configured;
    return value && value.trim() ? value : 'WorkBuddy/2.137.1';
  }

  async start(owner: string, note?: string): Promise<LoginStatus & { authorization_url: string }> {
    if (this.closed) throw new OAuthError(503, 'oauth_unavailable');
    if ([...this.transactions.values()].some((t) => t.owner === owner && active.has(t.status))) {
      throw new OAuthError(409, 'oauth_already_pending');
    }
    if (this.transactions.size >= 32) throw new OAuthError(429, 'oauth_too_many_sessions');
    const id = randomBytes(24).toString('base64url');
    const t: Transaction = {
      id,
      owner,
      status: 'starting',
      expires_at: Date.now() + this.loginTimeout,
      controller: new AbortController(),
      expiryTimer: setTimeout(() => this.finish(t, 'expired'), this.loginTimeout),
    };
    t.expiryTimer.unref();
    this.transactions.set(id, t);
    try {
      const raw = await this.request('/auth/state?platform=workbuddy-ai', 'POST', {}, t.controller.signal);
      const state = z.object({ authUrl: z.string().url(), state: secret }).safeParse(raw);
      if (!state.success) throw new OAuthError(502, 'oauth_invalid_state_response');
      const url = new URL(state.data.authUrl);
      if (!AUTH_ORIGINS.has(url.origin) || url.username || url.password)
        throw new OAuthError(502, 'oauth_untrusted_authorization_url');
      const version = /\/(\d+\.\d+\.\d+)$/.exec(this.userAgent())?.[1];
      if (version && !url.searchParams.has('version')) url.searchParams.set('version', version);
      this.ensureActive(t);
      t.status = 'pending';
      void this.poll(t, state.data.state, note);
      return { ...this.status(id, owner), authorization_url: url.toString() };
    } catch (err) {
      this.finish(t, 'failed', err instanceof OAuthError ? err.code : 'oauth_network_error');
      throw err instanceof OAuthError ? err : new OAuthError(502, 'oauth_network_error');
    }
  }

  status(id: string, owner: string): LoginStatus {
    const t = this.owned(id, owner);
    if (active.has(t.status) && Date.now() >= t.expires_at) this.finish(t, 'expired');
    return {
      id: t.id,
      status: t.status,
      expires_at: t.expires_at,
      ...(t.account_label ? { account_label: t.account_label } : {}),
      ...(t.error ? { error: t.error } : {}),
    };
  }

  cancel(id: string, owner: string): LoginStatus {
    const t = this.owned(id, owner);
    this.finish(t, 'cancelled');
    return this.status(id, owner);
  }

  close(): void {
    this.closed = true;
    for (const t of this.transactions.values()) {
      t.controller.abort();
      clearTimeout(t.expiryTimer);
      clearTimeout(t.cleanupTimer);
    }
    this.transactions.clear();
  }

  async refreshCredential(credential: WorkBuddyCredential): Promise<WorkBuddyCredential> {
    if (
      credential.oauthOrigin !== AUTH_ORIGIN ||
      !credential.refreshToken ||
      (credential.refreshExpiresAt !== undefined && credential.refreshExpiresAt <= Date.now())
    ) {
      throw new OAuthError(401, 'oauth_reauthentication_required');
    }
    const raw = await this.request('/auth/token/refresh', 'POST', {
      'X-Refresh-Token': credential.refreshToken,
      'X-Auth-Refresh-Source': 'plugin',
    });
    const fresh = this.toCredential(raw, credential.userId);
    await this.checkAccounts(fresh);
    return {
      ...fresh,
      refreshToken: fresh.refreshToken ?? credential.refreshToken,
      refreshExpiresAt: fresh.refreshExpiresAt ?? credential.refreshExpiresAt,
    };
  }

  private async poll(t: Transaction, officialState: string, note?: string): Promise<void> {
    try {
      const auth = await this.waitData(t, '/auth/token?state=' + encodeURIComponent(officialState), 11217);
      this.ensureActive(t);
      t.status = 'token_received';
      const parsedAuth = authSchema.safeParse(auth);
      if (!parsedAuth.success) throw new OAuthError(502, 'oauth_invalid_token_response');
      const headers = { Authorization: `Bearer ${parsedAuth.data.accessToken}` };
      const rawAccount = await this.waitData(
        t,
        '/login/account?state=' + encodeURIComponent(officialState),
        12151,
        headers,
      );
      const account = accountSchema.safeParse(rawAccount);
      if (!account.success) throw new OAuthError(502, 'oauth_invalid_account_response');
      this.ensureActive(t);
      t.status = 'account_received';
      const credential = this.toCredential(auth, account.data.uid);
      await this.checkAccounts(credential, t.controller.signal);
      this.ensureActive(t);
      // Completion includes durable pool insertion before the login is marked complete.
      t.account_label = await this.opts.onComplete(credential, note);
      this.finish(t, 'completed');
    } catch (err) {
      this.finish(t, 'failed', err instanceof OAuthError ? err.code : 'oauth_network_error');
    }
  }

  private async waitData(
    t: Transaction,
    path: string,
    pendingCode: number,
    headers: Record<string, string> = {},
  ): Promise<unknown> {
    for (;;) {
      this.ensureActive(t);
      await delay(this.pollInterval, undefined, { signal: t.controller.signal });
      this.ensureActive(t);
      const data = await this.request(path, 'GET', headers, t.controller.signal, pendingCode);
      this.ensureActive(t);
      if (data !== undefined && data !== null) return data;
    }
  }

  private toCredential(raw: unknown, userId: string): WorkBuddyCredential {
    const parsed = authSchema.safeParse(raw);
    if (!parsed.success) throw new OAuthError(502, 'oauth_invalid_token_response');
    const auth = parsed.data;
    if (auth.tokenType && auth.tokenType.toLowerCase() !== 'bearer')
      throw new OAuthError(502, 'oauth_unsupported_token_type');
    if (auth.domain && auth.domain !== 'www.workbuddy.ai') throw new OAuthError(502, 'oauth_domain_mismatch');
    const expiresAt = auth.expiresAt ?? (auth.expiresIn ? Date.now() + auth.expiresIn * 1_000 : undefined);
    if (expiresAt !== undefined && expiresAt <= Date.now()) throw new OAuthError(401, 'oauth_token_expired');
    return {
      accessToken: auth.accessToken,
      userId,
      domain: 'www.workbuddy.ai',
      oauthOrigin: AUTH_ORIGIN,
      tokenType: 'Bearer',
      refreshToken: auth.refreshToken,
      expiresAt,
      refreshExpiresAt:
        auth.refreshExpiresAt ??
        (auth.refreshExpiresIn ? Date.now() + auth.refreshExpiresIn * 1_000 : undefined),
    };
  }

  private async checkAccounts(credential: WorkBuddyCredential, signal?: AbortSignal): Promise<void> {
    const raw = await this.request(
      '/accounts',
      'GET',
      { Authorization: `Bearer ${credential.accessToken}` },
      signal,
    );
    const result = z.object({ accounts: z.array(accountSchema) }).safeParse(raw);
    if (!result.success || !result.data.accounts.some((a) => a.uid === credential.userId))
      throw new OAuthError(502, 'oauth_account_mismatch');
  }

  private owned(id: string, owner: string): Transaction {
    const t = this.transactions.get(id);
    if (!t || t.owner !== owner) throw new OAuthError(404, 'oauth_session_not_found');
    return t;
  }

  private ensureActive(t: Transaction): void {
    if (Date.now() >= t.expires_at) this.finish(t, 'expired');
    if (!active.has(t.status) || t.controller.signal.aborted || this.closed)
      throw new OAuthError(409, 'oauth_session_ended');
  }

  private finish(t: Transaction, status: LoginPhase, error?: string): void {
    if (!active.has(t.status)) return;
    t.status = status;
    t.error = error;
    clearTimeout(t.expiryTimer);
    t.controller.abort();
    t.cleanupTimer = setTimeout(() => this.transactions.delete(t.id), 60_000);
    t.cleanupTimer.unref();
  }

  private async request(
    path: string,
    method: 'GET' | 'POST',
    headers: Record<string, string> = {},
    signal?: AbortSignal,
    pendingCode?: number,
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.requestTimeout);
    const abort = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await this.fetchFn(AUTH_ORIGIN + '/v2/plugin' + path, {
        method,
        redirect: 'error',
        signal: abort,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Domain': 'www.workbuddy.ai',
          'X-Product': 'SaaS',
          'User-Agent': this.userAgent(),
          ...headers,
        },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      if (!res.body) throw new OAuthError(502, 'oauth_invalid_response');
      const reader = res.body.getReader();
      let text = '',
        size = 0;
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 1_048_576) throw new OAuthError(502, 'oauth_response_too_large');
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      let body: { code?: unknown; data?: unknown };
      try {
        body = JSON.parse(text);
      } catch {
        throw new OAuthError(502, 'oauth_invalid_response');
      }
      if (!body || typeof body !== 'object') throw new OAuthError(502, 'oauth_invalid_response');
      if (res.status === 429) throw new OAuthError(429, 'oauth_rate_limited');
      if (res.status === 401 || res.status === 403)
        throw new OAuthError(res.status, 'oauth_reauthentication_required');
      if (pendingCode !== undefined && Number(body.code) === pendingCode) return undefined;
      if (!res.ok || (body.code !== undefined && Number(body.code) !== 0))
        throw new OAuthError(502, 'oauth_upstream_rejected');
      return body.data;
    } catch (err) {
      if (err instanceof OAuthError) throw err;
      throw new OAuthError(502, 'oauth_network_error');
    }
  }
}
