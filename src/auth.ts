import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { digest, passwordHash, verifyPassword } from './crypto.js';
import { AppError } from './errors.js';
import type { Store } from './store.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Client API key row id for the current request, when the caller sent one. */
    apiKeyId: string | null;
    apiKeyName: string | null;
  }
}

const SESSION_COOKIE = 'wkbdy_session';
const SESSION_SECONDS = 30 * 86400;

/**
 * Admin authentication: a password-seeded session cookie for the panel and a
 * separate table of client API keys for `/v1`. The admin password is hashed in
 * SQLite; the `.env` value only initialises it on first start.
 */
export class Auth {
  private failures = new Map<string, { count: number; expires: number }>();

  constructor(
    private readonly store: Store,
    initialPassword: string,
    private readonly secure: boolean,
  ) {
    if (!store.meta<string>('adminPassword')) store.setMeta('adminPassword', passwordHash(initialPassword));
  }

  csrf(request: FastifyRequest): void {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers['x-admin-request'] !== '1') {
      throw new AppError(403, 'csrf_required', 'The X-Admin-Request header is required');
    }
  }

  session(request: FastifyRequest): string {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) throw new AppError(401, 'unauthorized', 'Sign in to continue');
    const hash = digest(token);
    const row = this.store.db.prepare('SELECT expires_at FROM sessions WHERE hash=?').get(hash) as
      { expires_at: number } | undefined;
    if (!row || row.expires_at <= Date.now())
      throw new AppError(401, 'unauthorized', 'The session has expired');
    return hash;
  }

  admin = async (request: FastifyRequest) => {
    this.csrf(request);
    this.session(request);
  };

  login(password: string, request: FastifyRequest, reply: FastifyReply): { expiresAt: number } {
    this.csrf(request);
    const now = Date.now();
    for (const [ip, item] of this.failures) if (item.expires <= now) this.failures.delete(ip);
    const failure = this.failures.get(request.ip);
    if (failure && failure.count >= 5) {
      throw new AppError(429, 'login_rate_limited', 'Too many sign-in attempts. Try again in five minutes.');
    }
    if (!verifyPassword(password, this.store.meta<string>('adminPassword')!)) {
      if (this.failures.size > 10000) this.failures.delete(this.failures.keys().next().value!);
      this.failures.set(request.ip, {
        count: (failure?.count ?? 0) + 1,
        expires: failure?.expires || now + 300000,
      });
      throw new AppError(401, 'invalid_password', 'Incorrect password');
    }
    this.failures.delete(request.ip);
    this.store.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + SESSION_SECONDS * 1000;
    this.store.db
      .prepare('INSERT INTO sessions (hash,expires_at) VALUES (?,?)')
      .run(digest(token), expiresAt);
    void reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: this.secure,
      maxAge: SESSION_SECONDS,
    });
    return { expiresAt };
  }

  logout(request: FastifyRequest, reply: FastifyReply): void {
    const token = request.cookies[SESSION_COOKIE];
    if (token) this.store.db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(token));
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  changePassword(current: string, next: string): void {
    if (!verifyPassword(current, this.store.meta<string>('adminPassword')!)) {
      throw new AppError(400, 'invalid_password', 'Current password is incorrect');
    }
    this.store.db.transaction(() => {
      this.store.setMeta('adminPassword', passwordHash(next));
      this.store.db.prepare('DELETE FROM sessions').run();
    })();
  }
}

/** Resolve the downstream client key from `Authorization: Bearer <key>`. */
export function resolveApiKey(store: Store, request: FastifyRequest): { id: string; name: string } | null {
  const header = request.headers.authorization;
  const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
  if (!bearer) return null;
  const id = store.authenticateKey(bearer);
  if (!id) return null;
  return { id, name: store.keys().find((key) => key.id === id)?.name ?? '' };
}

export { SESSION_COOKIE };
