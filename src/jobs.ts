import type { OAuthBroker } from './oauth.js';
import type { Store } from './store.js';

const TICK_MS = 60_000;

/**
 * Background maintenance: refresh tokens that are about to expire and trim the
 * request log. Both are no-ops when the corresponding setting is disabled.
 */
export class Jobs {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly oauth: OAuthBroker,
    private readonly log: (message: string, fields?: Record<string, unknown>) => void,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const settings = this.store.settings();
      if (settings.tokenRefresh.enabled) {
        const horizon = now + settings.tokenRefresh.intervalMinutes * 60_000;
        for (const account of this.store.accounts()) {
          if (!account.enabled || account.needsReauth) continue;
          if (!account.hasRefreshToken) continue;
          if (account.expiresAt === null || account.expiresAt > horizon) continue;
          const credential = this.store.upstreamCredential(account.id);
          if (!credential) continue;
          try {
            const refreshed = await this.oauth.refreshCredential(credential);
            this.store.saveCredential(account.id, refreshed);
            this.store.reportSuccess(account.id);
            this.log('account token refreshed', { account: account.id });
          } catch (error) {
            const status = (error as { statusCode?: number }).statusCode;
            if (status === 401 || status === 403) {
              this.store.markReauth(account.id, 'Token refresh was rejected.');
              this.log('account requires a new login', { account: account.id });
            } else {
              this.store.reportFailure(
                account.id,
                settings.pool.cooldownSeconds * 1000,
                'Token refresh failed.',
              );
            }
          }
        }
      }
      const pruned = this.store.pruneLogs(settings);
      if (pruned > 0) this.log('pruned request logs', { removed: pruned });
    } finally {
      this.running = false;
    }
  }
}
