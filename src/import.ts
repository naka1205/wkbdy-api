import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { stripBearer, type WorkBuddyCredential } from './credentials.js';

const DEFAULT_DOMAIN = 'www.workbuddy.ai';

const accountSchema = z
  .object({
    uid: z.string().min(1),
    email: z.string().optional(),
    auth: z.unknown().optional(),
  })
  .passthrough();

const authSchema = z
  .object({
    accessToken: z.string().min(1),
    refreshToken: z.string().optional(),
    domain: z.string().optional(),
  })
  .passthrough();

type Candidate = {
  account: unknown;
  auth: unknown;
};

export type LocalImportIssueCode = 'format_error' | 'expired' | 'identity_mismatch' | 'invalid_domain';

export type LocalImportIssue = {
  code: LocalImportIssueCode;
  message: string;
};

export type LocalImportResult = {
  credentials: Array<{ credential: WorkBuddyCredential; note: string }>;
  issues: LocalImportIssue[];
};

export class LocalImportError extends Error {
  constructor(
    readonly code: 'file_not_found' | 'format_error' | 'read_error',
    message: string,
  ) {
    super(message);
    this.name = 'LocalImportError';
  }
}

export async function readLocalWorkBuddyAccounts(path: string, now = Date.now()): Promise<LocalImportResult> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new LocalImportError('file_not_found', '未找到本机 WorkBuddy 凭据文件。');
    }
    throw new LocalImportError('read_error', '无法读取本机 WorkBuddy 凭据文件。');
  }

  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    throw new LocalImportError('format_error', 'WorkBuddy 凭据文件不是有效 JSON。');
  }

  const candidates = collectCandidates(document);
  if (candidates.length === 0) {
    throw new LocalImportError('format_error', 'WorkBuddy 凭据文件缺少可识别的账号结构。');
  }

  const credentials: LocalImportResult['credentials'] = [];
  const issues: LocalImportIssue[] = [];

  for (const candidate of candidates) {
    const account = accountSchema.safeParse(candidate.account);
    const auth = authSchema.safeParse(candidate.auth);
    if (!account.success || !auth.success) {
      issues.push({ code: 'format_error', message: '账号缺少必要字段。' });
      continue;
    }

    const token = stripBearer(auth.data.accessToken);
    const payload = parseJwtPayload(token);
    if (!payload) {
      issues.push({ code: 'format_error', message: '账号令牌格式无效。' });
      continue;
    }
    if (payload.sub !== account.data.uid) {
      issues.push({ code: 'identity_mismatch', message: '账号身份与令牌不匹配。' });
      continue;
    }
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) {
      issues.push({ code: 'expired', message: '账号令牌已过期或缺少有效期。' });
      continue;
    }

    const domain = auth.data.domain ?? DEFAULT_DOMAIN;
    if (!isAllowedDomain(domain)) {
      issues.push({ code: 'invalid_domain', message: '账号域名无效。' });
      continue;
    }

    credentials.push({
      credential: { accessToken: token, userId: account.data.uid, domain },
      note: buildSafeNote(account.data.email, account.data.uid),
    });
  }

  return { credentials, issues };
}

function collectCandidates(document: unknown): Candidate[] {
  if (!document || typeof document !== 'object') return [];
  const root = document as Record<string, unknown>;
  const candidates: Candidate[] = [];

  if (root.account && root.auth) {
    candidates.push({ account: root.account, auth: root.auth });
  }

  for (const key of ['accounts', 'allAccounts']) {
    const value = root[key];
    const entries = Array.isArray(value)
      ? value
      : value && typeof value === 'object'
        ? Object.values(value as Record<string, unknown>)
        : [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      candidates.push({
        account: record.account ?? entry,
        auth: record.auth ?? root.auth,
      });
    }
  }

  return candidates;
}

function parseJwtPayload(token: string): { sub?: unknown; exp?: unknown } | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' ? payload : undefined;
  } catch {
    return undefined;
  }
}

function isAllowedDomain(domain: string): boolean {
  const normalized =
    domain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .split('/')[0] ?? '';
  return normalized === 'workbuddy.ai' || normalized.endsWith('.workbuddy.ai');
}

function buildSafeNote(email: string | undefined, uid: string): string {
  const uidSuffix = uid.slice(-4);
  if (!email || !email.includes('@')) return `本机 WorkBuddy · UID …${uidSuffix}`;
  const domain = email.slice(email.lastIndexOf('@') + 1);
  return `本机 WorkBuddy · …@${domain} · UID …${uidSuffix}`;
}
