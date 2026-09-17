import 'dotenv/config';
import { resolve } from 'node:path';
import { z } from 'zod';

const httpUrl = z
  .string()
  .url()
  .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), 'HTTP(S) URL required');

/**
 * Runtime settings live in the database, not in .env, so the panel can change
 * scheduling and logging without a restart. Env values only seed the defaults
 * on first startup.
 */
export const settingsSchema = z
  .object({
    strategy: z.enum(['round-robin', 'random']).default('round-robin'),
    pool: z.object({
      /** Per-account cooldown after a transient upstream failure. */
      cooldownSeconds: z.number().min(0).max(3600),
      /**
       * `key`: a client key keeps one upstream account until that account stops
       * working, so a long-running client session stays on the same identity.
       * `none`: every request picks an account on its own.
       */
      accountBinding: z.enum(['key', 'none']).default('key'),
    }),
    upstream: z.object({
      url: httpUrl,
      userAgent: z.string().min(1).max(200),
    }),
    tokenRefresh: z.object({
      enabled: z.boolean(),
      intervalMinutes: z.number().int().min(1).max(1440),
    }),
    logging: z.object({
      retentionDays: z.number().int().min(1).max(365),
      maxEntries: z.number().int().min(100).max(1000000),
    }),
  })
  .strict();

export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = {
  strategy: 'round-robin',
  pool: { cooldownSeconds: 60, accountBinding: 'key' },
  upstream: {
    url: 'https://www.workbuddy.ai/v2/chat/completions',
    userAgent: 'WorkBuddy/2.137.1',
  },
  tokenRefresh: { enabled: true, intervalMinutes: 30 },
  logging: { retentionDays: 30, maxEntries: 50000 },
};

export interface EnvConfig {
  host: string;
  port: number;
  adminPassword: string;
  dataDir: string;
  staticDir: string;
  publicBaseUrl: string;
  catalogPath: string;
  /** Optional startup seed for the runtime upstream settings. */
  upstreamUrl?: string;
  upstreamUserAgent?: string;
  encryptionKey?: string;
  apiKeys: string[];
  credentialsPath?: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'silent';
}

export function loadEnv(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  const raw = z
    .object({
      PORT: z.coerce.number().int().min(1).max(65535).default(7891),
      HOST: z.string().default('127.0.0.1'),
      ADMIN_PASSWORD: z.string().min(8, 'Set ADMIN_PASSWORD to at least 8 characters in .env'),
      PUBLIC_BASE_URL: httpUrl.optional(),
      LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']).default('info'),
    })
    .parse(env);
  return {
    host: raw.HOST,
    port: raw.PORT,
    adminPassword: raw.ADMIN_PASSWORD,
    dataDir: resolve(env.DATA_DIR || './data'),
    staticDir: resolve(env.STATIC_DIR || './static'),
    publicBaseUrl: raw.PUBLIC_BASE_URL || `http://localhost:${raw.PORT}`,
    catalogPath: resolve(env.WKB2API_CATALOG_PATH || './config/wb_v3config.public.json'),
    ...(env.WKB2API_UPSTREAM_URL ? { upstreamUrl: env.WKB2API_UPSTREAM_URL } : {}),
    ...(env.WKB2API_UPSTREAM_UA ? { upstreamUserAgent: env.WKB2API_UPSTREAM_UA } : {}),
    encryptionKey: env.TOKEN_ENCRYPTION_KEY || undefined,
    apiKeys: (env.API_KEYS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    credentialsPath: env.WKB2API_CREDENTIALS_PATH || undefined,
    logLevel: raw.LOG_LEVEL,
  };
}
