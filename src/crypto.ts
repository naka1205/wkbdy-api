import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export function passwordHash(password: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash || hash.length !== 128) return false;
  return timingSafeEqual(Buffer.from(hash, 'hex'), scryptSync(password, salt, 64));
}

/**
 * Account credentials are encrypted with AES-256-GCM. The key is created in
 * DATA_DIR/encryption.key on first start; restoring a database without its
 * matching key makes every token unreadable, which is the intended trade-off.
 */
export class Vault {
  private readonly key: Buffer;

  constructor(dataDir: string, providedKey?: string) {
    const file = join(dataDir, 'encryption.key');
    if (providedKey) {
      this.key = Buffer.from(providedKey, 'base64');
    } else {
      if (!existsSync(file)) {
        writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
      }
      this.key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
      chmodSync(file, 0o600);
    }
    if (this.key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  }

  encrypt(value: string): string {
    if (!value) return '';
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return [
      'v1',
      nonce.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      body.toString('base64'),
    ].join('.');
  }

  decrypt(value: string): string {
    if (!value) return '';
    const [version, nonce, tag, body] = value.split('.');
    if (version !== 'v1' || !nonce || !tag || !body) throw new Error('Invalid encrypted credential');
    const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(nonce, 'base64'));
    cipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([cipher.update(Buffer.from(body, 'base64')), cipher.final()]).toString('utf8');
  }
}
