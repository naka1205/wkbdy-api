import Fastify, { LogController, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { Accounts } from './accounts.js';
import { Auth, resolveApiKey } from './auth.js';
import { defaultSettings, loadEnv, type EnvConfig } from './config.js';
import { openDatabase } from './db.js';
import { AppError, errorMessage, redactError } from './errors.js';
import { Jobs } from './jobs.js';
import { OAuthBroker } from './oauth.js';
import { openAiError } from './openai/errors.js';
import { adminRoutes, syncCatalog } from './routes/admin.js';
import { modelsRoutes } from './routes/models.js';
import { responsesRoutes } from './routes/responses.js';
import { chatCompletionsRoutes } from './proxy.js';
import { accountInput, Store } from './store.js';
import { WorkBuddyClient } from './upstream.js';
import { Vault } from './crypto.js';
import { tokenClaims } from './credentials.js';

export type CreateServerOptions = {
  env?: EnvConfig;
  /** Injected for tests; defaults to global fetch. */
  fetcher?: typeof fetch;
  /** Disable background jobs in tests. */
  jobs?: boolean;
  version?: string;
};

/**
 * Build the whole service: database, vault, store, account scheduler, upstream
 * client, admin API and the OpenAI-compatible gateway routes.
 */
export async function createServer(options: CreateServerOptions = {}) {
  const env = options.env ?? loadEnv();
  const version = options.version ?? '1.0.0';
  const db = openDatabase(env.dataDir);
  let vault: Vault;
  try {
    vault = new Vault(env.dataDir, env.encryptionKey);
  } catch (error) {
    db.close();
    throw error;
  }
  const store = new Store(db, vault);
  // Fail at startup if the data directory was restored without its matching key.
  try {
    store.accounts();
  } catch {
    db.close();
    throw new Error('Cannot decrypt accounts. Restore the matching encryption.key or TOKEN_ENCRYPTION_KEY.');
  }
  store.seedSettings({
    ...(env.upstreamUrl || env.upstreamUserAgent
      ? {
          upstream: {
            url: env.upstreamUrl ?? defaultSettings.upstream.url,
            userAgent: env.upstreamUserAgent ?? defaultSettings.upstream.userAgent,
          },
        }
      : {}),
  });
  if (!store.meta('keysInitialized')) {
    for (const [index, key] of [...new Set(env.apiKeys)].entries())
      store.addKey(`Initial key ${index + 1}`, key);
    store.setMeta('keysInitialized', true);
  }
  if (!store.models().length) {
    try {
      await syncCatalog(env.catalogPath, store);
    } catch (error) {
      db.close();
      throw new Error(`Cannot load the model catalog from ${env.catalogPath}: ${errorMessage(error)}`);
    }
  }

  const app = Fastify({
    logger:
      env.logLevel === 'silent'
        ? false
        : {
            level: env.logLevel,
            redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-key"]'],
          },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 16 * 1024 * 1024,
    genReqId: () => randomUUID(),
    requestTimeout: 0,
  });
  app.decorateRequest('apiKeyId', null);
  app.decorateRequest('apiKeyName', null);

  const auth = new Auth(store, env.adminPassword, new URL(env.publicBaseUrl).protocol === 'https:');
  const accounts = new Accounts(store, () => store.settings().pool.cooldownSeconds * 1000);
  const client = new WorkBuddyClient({
    upstreamUrl: () => store.settings().upstream.url,
    userAgent: () => store.settings().upstream.userAgent,
    credentials: accounts,
    ...(options.fetcher ? { fetchFn: options.fetcher } : {}),
  });
  const oauth = new OAuthBroker({
    userAgent: () => store.settings().upstream.userAgent,
    ...(options.fetcher ? { fetchFn: options.fetcher } : {}),
    onComplete: async (credential, note) => {
      const claims = tokenClaims(credential.accessToken);
      const account = store.upsertAccount(
        accountInput.parse({
          note: note ?? '',
          source: 'oauth',
          accessToken: credential.accessToken,
          userId: credential.userId,
          domain: credential.domain,
          ...(claims?.email ? { email: claims.email } : {}),
          ...(credential.oauthOrigin ? { oauthOrigin: credential.oauthOrigin } : {}),
          refreshToken: credential.refreshToken ?? '',
          ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
          ...(credential.refreshExpiresAt ? { refreshExpiresAt: credential.refreshExpiresAt } : {}),
        }),
      );
      return account.name;
    },
  });
  accounts.setRefresher((credential) => oauth.refreshCredential(credential));
  const jobs = new Jobs(store, oauth, (message, fields) => app.log.info(fields ?? {}, message));

  // Every response carries the gateway request ID, including the early 401s the
  // auth hook writes before a route runs, so a client can always correlate.
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Request-Id', request.id);
    return payload;
  });

  // Downstream authentication for every /v1 route.
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0]!;
    if (!path.startsWith('/v1/')) return;
    const key = resolveApiKey(store, request);
    if (!key) {
      return reply.code(401).send(openAiError(401, 'invalid_api_key', 'Invalid or missing API key.').body);
    }
    request.apiKeyId = key.id;
    request.apiKeyName = key.name;
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    reply.header('X-Request-Id', request.id);
    const path = request.url.split('?')[0]!;
    const isAdmin = path.startsWith('/api/');
    const nativeStatus = error.statusCode;
    const status =
      error instanceof AppError
        ? error.statusCode
        : error instanceof ZodError
          ? 400
          : nativeStatus && nativeStatus < 500
            ? nativeStatus
            : 500;
    const message =
      error instanceof ZodError
        ? error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ')
        : error instanceof AppError
          ? redactError(error.message)
          : status < 500
            ? error.message
            : 'Internal server error';
    const retryAfter =
      error instanceof AppError && error.retryAfterSeconds !== undefined
        ? error.retryAfterSeconds
        : error instanceof AppError && 'availability' in error
          ? ((error as { availability: { retryAfterSeconds?: number } }).availability.retryAfterSeconds ?? 5)
          : undefined;
    if (retryAfter !== undefined) reply.header('Retry-After', String(retryAfter));
    if (status >= 500) {
      request.log.error(
        {
          requestId: request.id,
          route: request.routeOptions.url ?? path,
          message: redactError(error.message),
        },
        'Request failed',
      );
    }
    if (isAdmin) {
      return reply.code(status).send({
        error: {
          message,
          type: error instanceof AppError ? error.code : 'server_error',
          code: error instanceof AppError ? error.code : 'server_error',
          request_id: request.id,
        },
      });
    }
    const code = openAiCodeFor(status, error);
    const body = openAiError(status, code, message).body;
    return reply
      .code(status)
      .send(retryAfter === undefined ? body : { error: { ...body.error, retry_after: retryAfter } });
  });

  await app.register(cookie);
  await app.register(cors, {
    origin: true,
    credentials: true,
    // Correlation headers a client may send, plus the IDs the gateway returns.
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Api-Key',
      'X-Request-Id',
      'X-Logical-Request-Id',
      'X-Task-Id',
      'X-Query-Id',
      'X-Session-Id',
      'X-Zcode-Trace-Id',
      'X-Retry-Attempt',
    ],
    exposedHeaders: ['X-Request-Id', 'X-Logical-Request-Id', 'X-Task-Id', 'Retry-After'],
  });

  await app.register(modelsRoutes, { prefix: '/v1', store });
  await app.register(chatCompletionsRoutes, { prefix: '/v1', store, accounts, client });
  await app.register(responsesRoutes, { prefix: '/v1', store, accounts, client });
  await app.register(adminRoutes, {
    prefix: '/api/admin',
    auth,
    store,
    accounts,
    client,
    oauth,
    version,
    startedAt: Date.now(),
    catalogPath: env.catalogPath,
    ...(env.credentialsPath ? { credentialsPath: env.credentialsPath } : {}),
  });

  app.get('/health', async () => ({ status: 'ok', version }));
  app.get('/healthz', async () => ({ status: 'ok', version }));

  const hasAdmin = existsSync(join(env.staticDir, 'index.html'));
  if (hasAdmin) {
    await app.register(fastifyStatic, {
      root: env.staticDir,
      prefix: '/',
      maxAge: '1h',
      setHeaders(response, filePath) {
        if (filePath.endsWith('index.html')) response.header('Cache-Control', 'no-cache');
      },
    });
  } else {
    app.get('/', async () => ({
      service: 'wkbdy-api',
      version,
      admin: 'Build wkbdy-api-admin with npm run build:deploy',
    }));
  }
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply
        .code(404)
        .send({ error: { message: 'Route not found', type: 'not_found', code: 'not_found' } });
    }
    return reply
      .code(404)
      .send(openAiError(404, 'not_found', `Unknown route: ${request.method} ${request.url}`).body);
  });

  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        url: request.url,
        status: reply.statusCode,
        duration_ms: Math.round(reply.elapsedTime),
        api_key: request.apiKeyName || undefined,
      },
      'request',
    );
  });

  app.addHook('preClose', async () => {
    jobs.stop();
    oauth.close();
  });
  app.addHook('onClose', async () => {
    db.close();
  });

  if (options.jobs !== false) jobs.start();

  return { app, store, accounts, client, oauth, jobs, auth, env, version };
}

function openAiCodeFor(status: number, error: Error) {
  if (error instanceof AppError) {
    // A handful of gateway errors keep their own code in the OpenAI shape.
    if (error.code === 'invalid_correlation_id') return error.code;
    switch (status) {
      case 400:
        return 'invalid_request' as const;
      case 401:
        return 'invalid_api_key' as const;
      case 404:
        return 'not_found' as const;
      case 429:
        return 'rate_limit_exceeded' as const;
      case 499:
        return 'invalid_request' as const;
      default:
        return status >= 500 ? ('upstream_error' as const) : ('invalid_request' as const);
    }
  }
  return status === 404
    ? ('not_found' as const)
    : status < 500
      ? ('invalid_request' as const)
      : ('internal_error' as const);
}

export type ServerContext = Awaited<ReturnType<typeof createServer>>;
export type { FastifyInstance };
