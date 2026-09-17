import { z } from 'zod';
import { UpstreamHttpError, type UpstreamProtocolError } from './upstream.js';

/** Base class for every error that carries an intended HTTP status and code. */
export class AppError extends Error {
  retryAfterSeconds?: number;
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AppError';
  }
}

export { CredentialError } from './credentials.js';

export type AccountAvailability = {
  total: number;
  disabled: number;
  needsReauth: number;
  coolingDown: number;
  available: number;
  retryAfterSeconds?: number;
};

export class NoAvailableAccountsError extends AppError {
  constructor(readonly availability: AccountAvailability) {
    super(
      503,
      'no_available_account',
      'No WorkBuddy account is currently available; retry later or sign in again.',
    );
    this.name = 'NoAvailableAccountsError';
    this.retryAfterSeconds = availability.retryAfterSeconds;
  }
}

export class UpstreamError extends AppError {
  constructor(
    status: number,
    message: string,
    readonly upstream?: {
      endpoint?: string;
      httpStatus: number;
      code?: string;
      message?: string;
      retryAfterSeconds?: number;
    },
    readonly accountFailure?: 'credentials' | 'blocked',
  ) {
    super(status, 'upstream_error', message);
    this.name = 'UpstreamError';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected error';
}

const CREDENTIAL_CODES =
  /^(?:invalid_grant|invalid_token|invalid_refresh_token|refresh_token_expired|token_expired)$/i;

export function isCredentialFailure(status: number, code?: unknown, message?: unknown): boolean {
  if (status === 401 || status === 403) return true;
  return (
    CREDENTIAL_CODES.test(String(code ?? '')) ||
    (typeof message === 'string' && CREDENTIAL_CODES.test(message.trim()))
  );
}

const QUOTA_PATTERNS =
  /(?:余额|积分|额度|点数)(?:已)?(?:不足|耗尽|用尽|用完)|\binsufficient[ _-](?:balance|quota|credits?)\b|\b(?:balance|quota|credits?)(?: is)?[ _-](?:exhausted|depleted|insufficient)\b|\bcredit balance (?:is )?too low\b/i;

export function isQuotaFailure(status: number, code?: unknown, message?: unknown): boolean {
  if (status === 402) return true;
  const normalized = String(code ?? '').toLowerCase();
  if (
    [
      'insufficient_quota',
      'insufficient_balance',
      'quota_exhausted',
      'balance_exhausted',
      'credits_exhausted',
      // WorkBuddy's own code for "Credits exhausted".
      '14018',
    ].includes(normalized)
  )
    return true;
  return typeof message === 'string' && QUOTA_PATTERNS.test(message);
}

const BLOCKED_CODES = new Set(['410004']);

/**
 * Clients recover from an oversized prompt themselves: Codex marks the context
 * full, ZCode runs "reactive compaction". Both only recognise the failure when
 * the code (or message) is one of the canonical spellings below, so an
 * upstream overflow has to be translated instead of passed through verbatim.
 */
const CONTEXT_OVERFLOW_CODES = new Set([
  'context_length_exceeded',
  'context_window_exceeded',
  'context_exceeded',
  'model_context_exceeded',
  'model_context_window_exceeded',
  'prompt_too_long',
]);

const CONTEXT_OVERFLOW_PATTERNS =
  /(?:context|上下文)[^\n]{0,60}(?:exceed|overflow|too long|超(?:出|过|限))|(?:exceed|overflow|超(?:出|过))[^\n]{0,60}(?:context|上下文)|prompt is too long|maximum context length|input token count|range of input length should be|total message token length|输入(?:内容)?过长/i;

export function isContextOverflow(status: number, code?: unknown, message?: unknown): boolean {
  const normalized = String(code ?? '')
    .trim()
    .toLowerCase();
  if (CONTEXT_OVERFLOW_CODES.has(normalized)) return true;
  if (status >= 500) return false;
  return typeof message === 'string' && CONTEXT_OVERFLOW_PATTERNS.test(message);
}

const BLOCKED_PATTERNS =
  /封控|风控|账号(?:被)?(?:封禁|封停|限制|禁用|停用)|account (?:has been )?(?:blocked|banned|suspended|restricted)/i;

/**
 * Upstream risk control: the account itself may not be used any more, so the
 * pool disables it instead of retrying (autoclaw-api treats 410004 the same way).
 */
export function isAccountBlocked(code?: unknown, message?: unknown): boolean {
  if (BLOCKED_CODES.has(String(code ?? '').trim())) return true;
  return typeof message === 'string' && BLOCKED_PATTERNS.test(message);
}

export function isRateLimited(error: unknown): boolean {
  return (
    error instanceof UpstreamHttpError &&
    error.status === 429 &&
    !isQuotaFailure(429, error.code, error.upstreamMessage)
  );
}

/**
 * Strip credential-shaped substrings without changing the rest of the text.
 * Used by the protocol recorder, which must keep full request/response bodies
 * (unlike `redactError`, which is for short messages and truncates).
 */
export function redactCredentials(text: string): string {
  return text
    .replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '[redacted token]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted key]');
}

export function redactError(message: string, secrets: readonly string[] = []): string {
  let safe = message;
  const values = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const value of values) {
    const variants = [value];
    try {
      variants.push(encodeURIComponent(value));
    } catch {
      // Malformed Unicode in an upstream echo must not break redaction.
    }
    for (const variant of variants) safe = safe.replaceAll(variant, '[redacted]');
  }
  return redactCredentials(safe)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, 400);
}

export const zodMessage = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ');

export function isUpstreamProtocolError(error: unknown): error is UpstreamProtocolError {
  return error instanceof Error && error.name === 'UpstreamProtocolError';
}
