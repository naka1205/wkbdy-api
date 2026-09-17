/** Strip an accidental `Bearer ` prefix from a pasted token. */
export function stripBearer(token: string): string {
  return token.trim().replace(/^Bearer\s+/i, '');
}

export type WorkBuddyCredential = {
  /** Bearer token for the upstream Authorization header. Never logged. */
  accessToken: string;
  /** X-User-Id header value. Never logged. */
  userId: string;
  domain: string;
  /** OAuth metadata: never included in panel responses or logs. */
  oauthOrigin?: string;
  tokenType?: 'Bearer';
  refreshToken?: string;
  expiresAt?: number;
  refreshExpiresAt?: number;
};

export class CredentialError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CredentialError';
  }
}

export type TokenClaims = {
  userId: string;
  /** Keycloak hands the account's address back in the `email` claim. */
  email: string | null;
  expiresAt: number | null;
};

/** Decode the JWT claims the gateway cares about; malformed tokens yield null. */
export function tokenClaims(token: string): TokenClaims | null {
  try {
    const payload = JSON.parse(
      Buffer.from(stripBearer(token).split('.')[1] ?? '', 'base64url').toString('utf8'),
    );
    if (!payload || typeof payload !== 'object') return null;
    const claims = payload as Record<string, unknown>;
    const email = typeof claims.email === 'string' ? claims.email.trim() : '';
    return {
      userId: String(claims.sub ?? claims.user_id ?? ''),
      email: email ? email.slice(0, 200) : null,
      expiresAt: typeof claims.exp === 'number' ? (claims.exp as number) * 1000 : null,
    };
  } catch {
    return null;
  }
}
