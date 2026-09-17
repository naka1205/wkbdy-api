import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Auth } from '../auth.js';
import { AppError, redactError } from '../errors.js';
import { LocalImportError, readLocalWorkBuddyAccounts } from '../import.js';
import { OAuthError, type OAuthBroker } from '../oauth.js';
import { settingsSchema } from '../config.js';
import { accountInput, accountPatch, type Store } from '../store.js';
import { stripBearer, tokenClaims } from '../credentials.js';
import { ConfigParseError, parseProductConfig, toExposedModel } from '../catalog.js';
import { fromExposed } from '../models.js';
import type { Accounts } from '../accounts.js';
import type { WorkBuddyClient } from '../upstream.js';

export type AdminOptions = {
  auth: Auth;
  store: Store;
  accounts: Accounts;
  client: WorkBuddyClient;
  oauth: OAuthBroker;
  /** Version string reported by the panel and /health. */
  version: string;
  startedAt: number;
  catalogPath: string;
  credentialsPath?: string;
};

const passwordSchema = z.object({ password: z.string().min(1).max(200) }).strict();
const changePasswordSchema = z
  .object({ current: z.string().min(1).max(200), next: z.string().min(8).max(200) })
  .strict();
const addAccountSchema = z
  .object({
    token: z.string().min(20, 'token too short to be real').max(65536),
    user_id: z.string().trim().min(1).max(200).optional(),
    name: z.string().trim().max(100).optional(),
    note: z.string().trim().max(64).optional(),
    domain: z.string().trim().min(1).max(200).optional(),
    verify: z.boolean().optional(),
  })
  .strict();
const keySchema = z.object({ name: z.string().trim().max(100).optional() }).strict();
const logQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    model: z.string().max(200).optional(),
    status: z.enum(['success', 'error']).optional(),
    apiKeyId: z.string().max(128).optional(),
    /** Correlation lookup; always combined with apiKeyId by the panel. */
    taskId: z.string().max(128).optional(),
    logicalRequestId: z.string().max(128).optional(),
  })
  .strict();

export function adminRoutes(app: FastifyInstance, opts: AdminOptions): void {
  const { auth, store } = opts;

  app.post('/auth/login', async (request, reply) => {
    const { password } = passwordSchema.parse(request.body ?? {});
    const session = auth.login(password, request, reply);
    return { ok: true, expires_at: session.expiresAt };
  });
  app.post('/auth/logout', async (request, reply) => {
    auth.logout(request, reply);
    return { ok: true };
  });
  app.get('/auth/session', async (request) => {
    try {
      auth.session(request);
      return { authenticated: true };
    } catch {
      return { authenticated: false };
    }
  });
  app.post('/auth/password', { preHandler: auth.admin }, async (request) => {
    const body = changePasswordSchema.parse(request.body ?? {});
    auth.changePassword(body.current, body.next);
    return { ok: true };
  });

  app.get('/overview', { preHandler: auth.admin }, async () => ({
    version: opts.version,
    started_at: opts.startedAt,
    uptime_ms: Date.now() - opts.startedAt,
    upstream: {
      url: store.settings().upstream.url,
      user_agent: store.settings().upstream.userAgent,
      catalog_path: opts.catalogPath,
    },
    availability: store.availability(),
    pool: { size: opts.accounts.size, strategy: store.settings().strategy, accounts: opts.accounts.list() },
    models: { total: store.models().length, enabled: store.models().filter((model) => model.enabled).length },
    keys: store.keys().length,
    stats: store.stats(),
    recent: store.logs({ limit: 20 }).entries,
  }));

  // ---- accounts ---------------------------------------------------------

  app.get('/accounts', { preHandler: auth.admin }, async () => ({ accounts: opts.accounts.list() }));

  app.post('/accounts', { preHandler: auth.admin }, async (request) => {
    const body = addAccountSchema.parse(request.body ?? {});
    const token = stripBearer(body.token);
    const claims = tokenClaims(token);
    const userId = body.user_id ?? (claims?.userId ? claims.userId : undefined);
    if (!userId) {
      throw new AppError(
        400,
        'invalid_request',
        'user_id is required when the token carries no subject claim',
      );
    }
    const domain = body.domain ?? 'www.workbuddy.ai';
    if (body.verify !== false) {
      try {
        await opts.client.verifyCredential({ accessToken: token, userId });
      } catch (error) {
        throw new AppError(400, 'account_verification_failed', verificationMessage(error));
      }
    }
    const account = store.upsertAccount(
      accountInput.parse({
        name: body.name ?? '',
        note: body.note ?? '',
        source: 'manual',
        accessToken: token,
        userId,
        domain,
        ...(claims?.email ? { email: claims.email } : {}),
        ...(claims?.expiresAt ? { expiresAt: claims.expiresAt } : {}),
      }),
    );
    return { account: opts.accounts.list().find((entry) => entry.id === account.id) };
  });

  app.post('/accounts/import', { preHandler: auth.admin }, async () => {
    if (!opts.credentialsPath) {
      throw new AppError(
        400,
        'import_unavailable',
        'Set WKB2API_CREDENTIALS_PATH to enable local credential import.',
      );
    }
    let result;
    try {
      result = await readLocalWorkBuddyAccounts(opts.credentialsPath);
    } catch (error) {
      if (error instanceof LocalImportError) {
        throw new AppError(error.code === 'file_not_found' ? 404 : 400, error.code, error.message);
      }
      throw new AppError(500, 'import_failed', 'Could not import local WorkBuddy credentials.');
    }
    let imported = 0;
    for (const { credential, note } of result.credentials) {
      const claims = tokenClaims(credential.accessToken);
      store.upsertAccount(
        accountInput.parse({
          note,
          source: 'import',
          accessToken: credential.accessToken,
          userId: credential.userId,
          domain: credential.domain,
          ...(claims?.email ? { email: claims.email } : {}),
          ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
        }),
      );
      imported += 1;
    }
    return { imported, accepted: result.credentials.length, issues: result.issues };
  });

  app.patch<{ Params: { id: string } }>('/accounts/:id', { preHandler: auth.admin }, async (request) => {
    const patch = accountPatch.parse(request.body ?? {});
    const account = store.patchAccount(request.params.id, patch);
    if (!account) throw new AppError(404, 'account_not_found', 'Account not found');
    return { account: opts.accounts.list().find((entry) => entry.id === account.id) };
  });

  app.delete<{ Params: { id: string } }>('/accounts/:id', { preHandler: auth.admin }, async (request) => {
    if (!store.removeAccount(request.params.id))
      throw new AppError(404, 'account_not_found', 'Account not found');
    return { ok: true };
  });

  // Drops the sticky key assignment so the next request from that key picks a
  // different account; useful before decommissioning an account.
  app.post<{ Params: { id: string } }>(
    '/accounts/:id/release',
    { preHandler: auth.admin },
    async (request) => {
      const account = opts.accounts.list().find((entry) => entry.id === request.params.id);
      if (!account) throw new AppError(404, 'account_not_found', 'Account not found');
      const released = account.bound_key_id !== null;
      store.releaseBindingForAccount(request.params.id);
      return {
        ok: true,
        released,
        account: opts.accounts.list().find((entry) => entry.id === account.id),
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/accounts/:id/verify',
    { preHandler: auth.admin },
    async (request) => {
      const credential = store.credential(request.params.id);
      if (!credential) throw new AppError(404, 'account_not_found', 'Account not found');
      try {
        await opts.client.verifyCredential({
          accessToken: credential.accessToken,
          userId: credential.userId,
        });
        // The token carries the account address; a verify also backfills rows
        // that were created before email tracking existed.
        store.setAccountEmail(credential.id, tokenClaims(credential.accessToken)?.email);
        store.reportSuccess(credential.id);
        return { ok: true, detail: 'Upstream accepted the credential.' };
      } catch (error) {
        const message = redactError(verificationMessage(error));
        store.reportFailure(credential.id, 0, message);
        return { ok: false, detail: message };
      }
    },
  );

  // ---- oauth sign-in ----------------------------------------------------

  app.post('/oauth/start', { preHandler: auth.admin }, async (request) => {
    const body = z
      .object({ note: z.string().trim().max(64).optional() })
      .strict()
      .parse(request.body ?? {});
    const owner = auth.session(request);
    return opts.oauth.start(owner, body.note);
  });
  app.get<{ Params: { id: string } }>('/oauth/:id/status', { preHandler: auth.admin }, async (request) => {
    return opts.oauth.status(request.params.id, auth.session(request));
  });
  app.post<{ Params: { id: string } }>('/oauth/:id/cancel', { preHandler: auth.admin }, async (request) => {
    return opts.oauth.cancel(request.params.id, auth.session(request));
  });

  // ---- models -----------------------------------------------------------

  app.get('/models', { preHandler: auth.admin }, async () => ({
    models: store.models(),
    agents: store.catalog().agents,
    synced_at: store.catalog().syncedAt,
    catalog_path: opts.catalogPath,
  }));

  app.post('/models/sync', { preHandler: auth.admin }, async () => {
    const summary = await syncCatalog(opts.catalogPath, store);
    return { ...summary, models: store.models(), synced_at: store.meta<string>('catalogSyncedAt') };
  });

  app.patch<{ Params: { id: string } }>('/models/:id', { preHandler: auth.admin }, async (request) => {
    const model = store.patchModel(request.params.id, request.body ?? {});
    if (!model) throw new AppError(404, 'model_not_found', 'Model not found');
    return { model };
  });

  // ---- client API keys --------------------------------------------------

  app.get('/keys', { preHandler: auth.admin }, async () => ({ keys: store.keys() }));

  app.post('/keys', { preHandler: auth.admin }, async (request) => {
    const body = keySchema.parse(request.body ?? {});
    const created = store.addKey(body.name ?? 'API key');
    return { key: created.key, record: created.record };
  });

  app.delete<{ Params: { id: string } }>('/keys/:id', { preHandler: auth.admin }, async (request) => {
    if (!store.removeKey(request.params.id)) throw new AppError(404, 'key_not_found', 'API key not found');
    return { ok: true };
  });

  // ---- logs -------------------------------------------------------------

  app.get('/logs', { preHandler: auth.admin }, async (request) => {
    const query = logQuerySchema.parse(request.query ?? {});
    return store.logs(query);
  });

  app.delete('/logs', { preHandler: auth.admin }, async () => {
    store.clearLogs();
    return { ok: true };
  });

  app.get('/events', { preHandler: auth.admin }, async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');
    const onLog = (entry: { id?: number }) => {
      try {
        auth.session(request);
      } catch {
        reply.raw.end();
        return;
      }
      if (reply.raw.writableLength > 65536) {
        reply.raw.end();
        return;
      }
      reply.raw.write(`event: log\ndata: ${JSON.stringify({ id: entry.id })}\n\n`);
    };
    const heartbeat = setInterval(() => {
      try {
        auth.session(request);
        reply.raw.write(': heartbeat\n\n');
      } catch {
        reply.raw.end();
      }
    }, 15000);
    heartbeat.unref();
    store.events.on('log', onLog);
    reply.raw.on('close', () => {
      clearInterval(heartbeat);
      store.events.off('log', onLog);
    });
  });

  // ---- settings ---------------------------------------------------------

  app.get('/settings', { preHandler: auth.admin }, async () => ({ settings: store.settings() }));

  app.put('/settings', { preHandler: auth.admin }, async (request) => {
    const settings = store.saveSettings(settingsSchema.parse(request.body ?? {}));
    return { settings };
  });
}

/** Re-read the product catalog from disk and merge it into the model table. */
export async function syncCatalog(catalogPath: string, store: Store) {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(catalogPath, 'utf8'));
  } catch (error) {
    throw new AppError(400, 'catalog_unreadable', `Cannot read the catalog file: ${catalogPath}`);
  }
  try {
    const config = parseProductConfig(raw);
    const known = new Set(config.data.models.map((model) => model.id));
    for (const agent of config.data.agents) {
      const unknown = agent.models.find((id) => !known.has(id));
      if (unknown) {
        throw new AppError(
          400,
          'catalog_invalid',
          `Agent '${agent.name}' references unknown model '${unknown}'`,
        );
      }
    }
    return store.importCatalog({
      models: config.data.models.map((model) => fromExposed(toExposedModel(model))),
      agents: config.data.agents.map((agent) => ({
        name: agent.name,
        models: agent.models,
        ...(agent.modelTags ? { modelTags: agent.modelTags } : {}),
      })),
      ...(config.data.endpoint ? { endpoint: config.data.endpoint } : {}),
    });
  } catch (error) {
    if (error instanceof ConfigParseError) throw new AppError(400, 'catalog_invalid', error.message);
    throw error;
  }
}

function verificationMessage(error: unknown): string {
  if (error instanceof Error && 'upstreamMessage' in error) {
    const message = (error as { upstreamMessage?: string }).upstreamMessage;
    if (message) return message.slice(0, 200);
  }
  return error instanceof Error ? error.message : 'Upstream rejected the credential.';
}

export { OAuthError };
export type { FastifyRequest };
