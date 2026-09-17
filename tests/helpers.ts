import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { createServer } from '../src/server.js';
import type { EnvConfig } from '../src/config.js';
import { parseProductConfig, toExposedModel } from '../src/catalog.js';
import { fromExposed } from '../src/models.js';

export const CATALOG_PATH = fileURLToPath(new URL('../config/wb_v3config.public.json', import.meta.url));
export const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const ADMIN_PASSWORD = 'unit-test-password';
export const API_KEY = 'sk-wk-test-key-0123456789abcdef';

export const upstreamBody = JSON.stringify({
  model: 'deepseek-v4.1-flash',
  messages: [{ role: 'user', content: 'hi' }],
  stream: true,
});

/** Minimal SSE payload the upstream emits, including a usage-bearing finish frame. */
export const streamPayload =
  `data: ${JSON.stringify({ id: 'chatcmpl-1', model: 'deepseek-v4.1-flash', choices: [{ index: 0, delta: { role: 'assistant', content: '你' } }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '好' } }] })}\n\n` +
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\n` +
  'data: [DONE]\n\n';

export const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

export function sse(text: string, byteSize = 7): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < bytes.length; index += byteSize) {
          controller.enqueue(bytes.slice(index, index + byteSize));
        }
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

export type UpstreamCall = { url: string; headers: Headers; body: Record<string, any> };

/** Records every upstream call and answers with a queued or computed response. */
export class MockUpstream {
  readonly calls: UpstreamCall[] = [];
  handler: (call: UpstreamCall) => Response | Promise<Response> = () => sse(streamPayload);

  readonly fetch = (async (url: string | URL, init?: RequestInit) => {
    const call: UpstreamCall = {
      url: String(url),
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    };
    this.calls.push(call);
    return this.handler(call);
  }) as unknown as typeof fetch;

  get last(): UpstreamCall | undefined {
    return this.calls.at(-1);
  }

  get authorization(): string | undefined {
    return this.last?.headers.get('authorization') ?? undefined;
  }
}

export function testEnv(overrides: Partial<EnvConfig> = {}): EnvConfig {
  const dataDir = mkdtempSync(join(tmpdir(), 'wkbdy-api-test-'));
  return {
    host: '127.0.0.1',
    port: 0,
    adminPassword: ADMIN_PASSWORD,
    dataDir,
    staticDir: join(dataDir, 'static'),
    publicBaseUrl: 'http://localhost:7891',
    catalogPath: CATALOG_PATH,
    apiKeys: [API_KEY],
    logLevel: 'silent',
    ...overrides,
  };
}

/** The bundled product config, parsed. */
export function bundledConfig() {
  return parseProductConfig(JSON.parse(readFileSync(CATALOG_PATH, 'utf8')));
}

/** Catalog models from the bundled product config, ready for `store.importCatalog`. */
export function bundledCatalog() {
  const config = bundledConfig();
  return {
    models: config.data.models.map((model) => fromExposed(toExposedModel(model))),
    agents: config.data.agents.map((agent) => ({
      name: agent.name,
      models: agent.models,
      ...(agent.modelTags ? { modelTags: agent.modelTags } : {}),
    })),
  };
}

export async function fixture(
  t: TestContext,
  options: { upstream?: MockUpstream; env?: Partial<EnvConfig> } = {},
) {
  const upstream = options.upstream ?? new MockUpstream();
  const env = testEnv(options.env);
  const context = await createServer({ env, fetcher: upstream.fetch, jobs: false });
  t.after(async () => {
    await context.app.close();
    rmSync(env.dataDir, { recursive: true, force: true });
  });
  const login = await context.app.inject({
    method: 'POST',
    url: '/api/admin/auth/login',
    headers: { 'x-admin-request': '1' },
    payload: { password: ADMIN_PASSWORD },
  });
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  context.store.upsertAccount({
    name: 'test account',
    note: '',
    source: 'manual',
    accessToken: 'test-access-token-value',
    refreshToken: '',
    userId: 'user-1',
    domain: 'www.workbuddy.ai',
  });
  return {
    ...context,
    upstream,
    dataDir: env.dataDir,
    headers: { cookie, 'x-admin-request': '1' },
    apiHeaders: { authorization: `Bearer ${API_KEY}` },
  };
}

export function writeCatalog(path: string, models: Array<{ id: string; supportedLengths?: number[] }>) {
  writeFileSync(
    path,
    JSON.stringify({
      data: {
        models: models.map((model) => ({
          id: model.id,
          name: model.id,
          isDefault: false,
          supportsToolCall: true,
          supportsReasoning: true,
          contextWindow: model.supportedLengths
            ? { defaultLength: model.supportedLengths[0], supportedLengths: model.supportedLengths }
            : undefined,
        })),
        agents: [{ name: 'cli', models: models.map((model) => model.id) }],
      },
    }),
  );
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;
