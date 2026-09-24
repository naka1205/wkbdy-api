import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { createServer } from '../src/server.js';
import type { EnvConfig } from '../src/config.js';
import { parseProductConfig, toExposedModel } from '../src/catalog.js';
import { fromExposed } from '../src/models.js';

export const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));
/** Captured `/v3/config` payload the fake upstream serves and tests import. */
export const CATALOG_FIXTURE = fileURLToPath(new URL('./fixtures/catalog.json', import.meta.url));
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
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14, prompt_cache_hit_tokens: 8, completion_thinking_tokens: 3 } })}\n\n` +
  'data: [DONE]\n\n';

/** Usage block the gateway derives from {@link streamPayload}. */
export const streamUsage = {
  prompt_tokens: 10,
  completion_tokens: 4,
  total_tokens: 14,
  prompt_tokens_details: { cached_tokens: 8 },
  completion_tokens_details: { reasoning_tokens: 3 },
};

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
  /** Payload the fake product catalog endpoint answers with. */
  catalog: unknown = catalogPayload();
  /** Non-2xx makes the catalog endpoint fail instead of answering. */
  catalogStatus = 200;
  /** Thrown instead of answering, to exercise network failures. */
  catalogError?: Error;
  handler: (call: UpstreamCall) => Response | Promise<Response> = () => sse(streamPayload);

  readonly fetch = (async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    const call: UpstreamCall = {
      url: target,
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    };
    this.calls.push(call);
    // The product catalog shares the upstream host with the chat endpoint.
    if (target.endsWith('/v3/config')) {
      if (this.catalogError) throw this.catalogError;
      if (this.catalogStatus !== 200) return new Response('rejected', { status: this.catalogStatus });
      return json(this.catalog);
    }
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
  const dataDir = overrides.dataDir ?? mkdtempSync(join(tmpdir(), 'wkbdy-api-test-'));
  return {
    host: '127.0.0.1',
    port: 0,
    adminPassword: ADMIN_PASSWORD,
    dataDir,
    staticDir: join(dataDir, 'static'),
    publicBaseUrl: 'http://localhost:7891',
    apiKeys: [API_KEY],
    logLevel: 'silent',
    dumpRedact: false,
    ...overrides,
  };
}

/** The captured product config, parsed. */
export function bundledConfig() {
  return parseProductConfig(JSON.parse(readFileSync(CATALOG_FIXTURE, 'utf8')));
}

/** A minimal `/v3/config` payload; without arguments, the captured one. */
export function catalogPayload(
  models?: Array<{ id: string; supportedLengths?: number[] }>,
): Record<string, unknown> {
  if (!models) return JSON.parse(readFileSync(CATALOG_FIXTURE, 'utf8')) as Record<string, unknown>;
  return {
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
  };
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
  options: {
    upstream?: MockUpstream;
    env?: Partial<EnvConfig>;
    /** `false` starts with an empty model table, for catalog sync tests. */
    catalog?: boolean;
    /** `false` skips the demo account, for "nothing to schedule" tests. */
    account?: boolean;
  } = {},
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
  if (options.account !== false)
    context.store.upsertAccount({
      name: 'test account',
      note: '',
      source: 'manual',
      accessToken: 'test-access-token-value',
      refreshToken: '',
      userId: 'user-1',
      domain: 'www.workbuddy.ai',
    });
  if (options.catalog !== false) context.store.importCatalog(bundledCatalog());
  return {
    ...context,
    upstream,
    dataDir: env.dataDir,
    headers: { cookie, 'x-admin-request': '1' },
    apiHeaders: { authorization: `Bearer ${API_KEY}` },
  };
}

export type Fixture = Awaited<ReturnType<typeof fixture>>;
