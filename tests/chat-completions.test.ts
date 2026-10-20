import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONTEXT_WINDOW } from '../src/models.js';
import { json, sse, streamPayload, streamUsage, fixture, type Fixture } from './helpers.js';

const messages = [{ role: 'user', content: 'hi' }];
const post = (context: Fixture, payload: Record<string, unknown>) =>
  context.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: context.apiHeaders, payload });

test('a non-streaming request is aggregated from the upstream stream', async (t) => {
  const context = await fixture(t);
  const response = await post(context, { model: 'deepseek-v4.1-flash', messages });
  assert.equal(response.statusCode, 200);
  const body = response.json<{
    choices: Array<{ message: { content: string }; finish_reason: string }>;
    usage: unknown;
  }>();
  assert.equal(body.choices[0]!.message.content, '你好');
  assert.equal(body.choices[0]!.finish_reason, 'stop');
  assert.deepEqual(body.usage, streamUsage);

  const sent = context.upstream.last!;
  assert.equal(sent.body.stream, true);
  assert.deepEqual(sent.body.messages[0], { role: 'system', content: 'You are a helpful assistant.' });
  assert.equal(sent.headers.get('x-user-id'), 'user-1');
  assert.equal(sent.headers.get('x-domain'), 'www.workbuddy.ai');
  assert.equal(sent.headers.get('x-product'), 'SaaS');
  assert.match(sent.headers.get('user-agent') ?? '', /^WorkBuddy\//);
  assert.match(sent.headers.get('authorization') ?? '', /^Bearer /);
  // Upstream channel verification rejects calls missing any of these three.
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const name of [
    'x-conversation-id',
    'x-conversation-request-id',
    'x-conversation-message-id',
  ]) {
    assert.match(sent.headers.get(name) ?? '', uuid);
  }

  const logged = context.store.logs();
  assert.equal(logged.total, 1);
  assert.equal(logged.entries[0]!.status, 200);
  assert.equal(logged.entries[0]!.totalTokens, 14);
  // Prompt-cache and reasoning telemetry survives to the panel as well.
  assert.equal(logged.entries[0]!.cacheHitTokens, 8);
  assert.equal(logged.entries[0]!.reasoningTokens, 3);
  assert.equal(context.store.stats().cacheHitTokens24h, 8);
  assert.equal(logged.entries[0]!.apiKeyName, 'Initial key 1');
  assert.equal(logged.entries[0]!.accountId, context.store.accounts()[0]!.id);
  assert.equal(context.store.accounts()[0]!.requests, 1);
});

test('upstream credits are logged but never exposed to clients', async (t) => {
  const context = await fixture(t);
  context.upstream.handler = () =>
    sse(
      `data: ${JSON.stringify({ id: 'chatcmpl-c', choices: [{ index: 0, delta: { content: 'hi' } }] })}\n\n` +
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10, credit: 3 },
        })}\n\n` +
        'data: [DONE]\n\n',
    );

  const buffered = await post(context, { model: 'deepseek-v4.1-flash', messages });
  const body = buffered.json<{ usage: Record<string, unknown> }>();
  assert.deepEqual(body.usage, {
    prompt_tokens: 8,
    completion_tokens: 2,
    total_tokens: 10,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  });
  assert.equal(context.store.logs().entries[0]!.credits, 3);
  assert.equal(context.store.stats().credits24h, 3);
  // The account list shows consumption too, not just the per-request log.
  assert.equal(context.store.accounts()[0]!.credits, 3);
  assert.equal(context.store.accounts()[0]!.tokens, 10);

  const streamed = await post(context, {
    model: 'deepseek-v4.1-flash',
    messages,
    stream: true,
    stream_options: { include_usage: true },
  });
  assert.equal(streamed.statusCode, 200);
  const frames = streamed.body
    .split('\n\n')
    .filter((frame: string) => frame.startsWith('data: ') && !frame.includes('[DONE]'))
    .map((frame: string) => JSON.parse(frame.slice(6)));
  const usageChunk = frames.at(-1);
  assert.deepEqual(usageChunk.usage, {
    prompt_tokens: 8,
    completion_tokens: 2,
    total_tokens: 10,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  });
  assert.equal(context.store.logs().entries[0]!.credits, 3);
  assert.equal(context.store.accounts()[0]!.credits, 6);
  assert.equal(context.store.accounts()[0]!.requests, 2);
});

test('a streaming request forwards OpenAI chunks and terminates with [DONE]', async (t) => {
  const context = await fixture(t);
  const response = await post(context, { model: 'deepseek-v4.1-flash', messages, stream: true });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'] as string, /text\/event-stream/);
  const frames = response.body
    .split('\n\n')
    .filter((frame: string) => frame.startsWith('data: '))
    .map((frame: string) => frame.slice(6));
  assert.equal(frames.at(-1), '[DONE]');
  const parsed = frames.slice(0, -1).map((frame: string) => JSON.parse(frame));
  assert.equal(parsed[0].object, 'chat.completion.chunk');
  assert.equal(parsed.map((entry: any) => entry.choices[0]?.delta?.content ?? '').join(''), '你好');
  assert.equal(parsed.at(-1).choices[0].finish_reason, 'stop');
  assert.equal(context.store.logs().entries[0]!.stream, true);
});

test('stream_options.include_usage adds a usage-only final chunk', async (t) => {
  const context = await fixture(t);
  const response = await post(context, {
    model: 'deepseek-v4.1-flash',
    messages,
    stream: true,
    stream_options: { include_usage: true },
  });
  const payloads = response.body
    .split('\n\n')
    .filter((frame: string) => frame.startsWith('data: ') && !frame.includes('[DONE]'))
    .map((frame: string) => JSON.parse(frame.slice(6)));
  const usageChunk = payloads.at(-1);
  assert.deepEqual(usageChunk.choices, []);
  assert.deepEqual(usageChunk.usage, streamUsage);
});

test('parameters the gateway does not model are ignored, not rejected', async (t) => {
  const context = await fixture(t);
  const response = await post(context, {
    model: 'deepseek-v4.1-flash',
    messages,
    n: 2,
    prompt_cache_key: 'cache-me',
    response_format: { type: 'json_object' },
  });
  assert.equal(response.statusCode, 200);
  const sent = context.upstream.last!;
  assert.equal(sent.body.n, undefined);
  assert.equal(sent.body.response_format, undefined);
  assert.equal(sent.body.prompt_cache_key, undefined);

  // The log row still explains what was dropped.
  const entry = context.store.logs().entries[0]!;
  assert.match(entry.detail ?? '', /prompt_cache_key/);
  assert.match(entry.detail ?? '', /response_format/);
  assert.equal(entry.endpoint, '/v1/chat/completions');
});

test('max_tokens wins when a client sends both token limits', async (t) => {
  const context = await fixture(t);
  const response = await post(context, {
    model: 'deepseek-v4.1-flash',
    messages,
    max_tokens: 5,
    max_completion_tokens: 9,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(context.upstream.last!.body.max_tokens, 5);
  assert.match(context.store.logs().entries[0]!.detail ?? '', /max_completion_tokens/);
});

test('a transcript echoing reasoning_content leaves the log row clean', async (t) => {
  const context = await fixture(t);
  const response = await post(context, {
    model: 'deepseek-v4.1-flash',
    store: false,
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello', reasoning_content: 'thought about it' },
    ],
  });
  assert.equal(response.statusCode, 200);
  // Accepted but not forwarded, and not reported: the console line only fires
  // for genuinely unknown parameters, so a long transcript cannot flood it.
  assert.deepEqual(context.upstream.last!.body.messages, [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ]);
  assert.equal(context.store.logs().entries[0]!.detail, null);
});

test('a structurally invalid request is rejected with a field-level message', async (t) => {
  const context = await fixture(t);
  const invalid = await post(context, { model: '', messages });
  assert.equal(invalid.statusCode, 400);
  assert.equal(context.upstream.calls.length, 0);
  assert.equal(context.store.logs().entries[0]!.status, 400);

  const noMessages = await post(context, { model: 'deepseek-v4.1-flash', messages: [] });
  assert.equal(noMessages.statusCode, 400);
  assert.match(String(context.store.logs().entries[0]!.detail), /messages must contain at least one message/);
});

test('unknown models return 404 model_not_found', async (t) => {
  const context = await fixture(t);
  const response = await post(context, { model: 'nope', messages });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json<{ error: { code: string } }>().error.code, 'model_not_found');
});

test('the model context window is resolved and forwarded upstream', async (t) => {
  const context = await fixture(t);
  const model = context.store
    .models()
    .find((entry) => (entry.x_workbuddy.context_window?.supportedLengths.length ?? 0) > 1);
  if (!model) return;
  const lengths = [...model.x_workbuddy.context_window!.supportedLengths].sort((a, b) => a - b);
  await post(context, { model: model.id, messages, context_window: lengths[0] });
  assert.equal(context.upstream.last!.body.context_window, lengths[0]);
  // Client values are forwarded as-is, even outside the catalog lengths.
  await post(context, { model: model.id, messages, context_window: 250_000 });
  assert.equal(context.upstream.last!.body.context_window, 250_000);
  await post(context, { model: model.id, messages });
  assert.equal(context.upstream.last!.body.context_window, DEFAULT_CONTEXT_WINDOW);
  // A server-side selection beats the default but never the client value.
  context.store.patchModel(model.id, { context_window: lengths[0] });
  await post(context, { model: model.id, messages });
  assert.equal(context.upstream.last!.body.context_window, lengths[0]);
  await post(context, { model: model.id, messages, context_window: 999_999 });
  assert.equal(context.upstream.last!.body.context_window, 999_999);
});

test('upstream credential rejections become a retryable 429 and quarantine the account', async (t) => {
  const context = await fixture(t);
  context.upstream.handler = () => json({ code: 401, msg: 'invalid token' }, 401);
  const response = await post(context, { model: 'deepseek-v4.1-flash', messages });
  assert.equal(response.statusCode, 429);
  assert.equal(response.json<{ error: { code: string } }>().error.code, 'upstream_authentication_error');
  assert.equal(response.headers['retry-after'], '1');
  assert.equal(context.store.availability().available, 0);
  assert.equal(context.store.logs().entries[0]!.status, 429);
});

test('a context overflow comes back as context_length_exceeded', async (t) => {
  const context = await fixture(t);
  context.upstream.handler = () =>
    json(
      {
        error: {
          code: 'invalid_request',
          message:
            "This model's maximum context length is 200000 tokens. However, you requested 260000 tokens.",
        },
      },
      400,
    );
  const response = await post(context, { model: 'deepseek-v4.1-flash', messages });
  assert.equal(response.statusCode, 400);
  const body = response.json<{ error: { code: string; message: string } }>();
  assert.equal(body.error.code, 'context_length_exceeded');
  assert.match(body.error.message, /context .*exceed/i);
  // An oversized prompt is the client's problem, so the account stays usable.
  assert.equal(context.store.accounts()[0]!.enabled, true);
  assert.equal(context.store.availability().available, 1);
});

test('upstream rate limits and quota failures keep their meaning', async (t) => {
  const context = await fixture(t);
  context.upstream.handler = () =>
    new Response(JSON.stringify({ code: 429, msg: 'too many requests' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'retry-after': '7' },
    });
  const limited = await post(context, { model: 'deepseek-v4.1-flash', messages });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json<{ error: { code: string } }>().error.code, 'rate_limit_exceeded');
  assert.equal(limited.headers['retry-after'], '7');
  assert.equal(limited.json<{ error: { retry_after: number } }>().error.retry_after, 7);

  context.upstream.handler = () => json({ code: 402, msg: '账户余额不足' }, 402);
  const quota = await post(context, { model: 'deepseek-v4.1-flash', messages });
  assert.equal(quota.statusCode, 429);
  assert.equal(quota.json<{ error: { code: string } }>().error.code, 'insufficient_quota');
  // The upstream rejected a zero-cost model as well, so the account is parked
  // for every model until the balance is topped up.
  assert.equal(context.store.availability().available, 0);
  assert.equal(context.store.availability().quotaBlocked, 1);
});

test('an exhausted account is swapped out mid-request, so the task survives', async (t) => {
  const context = await fixture(t);
  context.store.upsertAccount({
    name: 'spare account',
    note: '',
    source: 'manual',
    accessToken: 'spare-access-token',
    refreshToken: '',
    userId: 'user-2',
    domain: 'www.workbuddy.ai',
  });
  const quota = { code: 14018, msg: 'Credits exhausted. Please buy more credits.' };
  context.upstream.handler = (call) =>
    call.headers.get('x-user-id') === 'user-1' ? json({ error: { data: quota } }, 429) : sse(streamPayload);

  const response = await post(context, { model: 'deepseek-v4.1-flash', messages });
  assert.equal(response.statusCode, 200);
  assert.equal(
    response.json<{ choices: Array<{ message: { content: string } }> }>().choices[0]!.message.content,
    '你好',
  );
  // One attempt per account: the exhausted one is retired, the spare serves the call.
  assert.deepEqual(
    context.upstream.calls.map((call) => call.headers.get('x-user-id')),
    ['user-1', 'user-2'],
  );
  const retired = context.store.accounts().find((account) => account.userId === 'user-1')!;
  // An empty balance parks the account for credit-consuming models only, so the
  // free model that just ran is not the reason it left this request.
  assert.ok(retired.quotaExhaustedAt !== null);
  assert.ok(retired.quotaRetryAfter! > Date.now());
  assert.equal(context.store.availability().available, 1);
  assert.equal(context.store.availability(true).available, 1);
});

test('the original account error surfaces when no spare account is left', async (t) => {
  const context = await fixture(t);
  context.upstream.handler = () => json({ code: 402, msg: '账户余额不足' }, 402);
  const response = await post(context, { model: 'deepseek-v4.1-flash', messages });
  assert.equal(response.statusCode, 429);
  const body = response.json<{ error: { code: string; retryable?: boolean; retry_after?: number } }>();
  assert.equal(body.error.code, 'insufficient_quota');
  assert.equal(response.headers['retry-after'], '1');
  assert.equal(body.error.retryable, true);
  assert.equal(body.error.retry_after, 1);
});

test('exhausting credits on a paid model leaves free models working', async (t) => {
  const context = await fixture(t);
  const accountId = context.store.accounts()[0]!.id;
  context.upstream.handler = () => json({ error: { data: { code: 14018, msg: 'Credits exhausted.' } } }, 429);

  const paid = await post(context, { model: 'gpt-5.6-sol', messages });
  assert.equal(paid.statusCode, 429);
  assert.equal(paid.json<{ error: { code: string } }>().error.code, 'insufficient_quota');
  assert.ok(context.store.account(accountId)!.quotaExhaustedAt !== null);
  // The account is only parked for credit-consuming models.
  assert.equal(context.store.account(accountId)!.quarantinedUntil, 0);
  assert.equal(context.store.availability().available, 1);
  assert.equal(context.store.availability(true).available, 0);

  context.upstream.handler = () => sse(streamPayload);
  const free = await post(context, { model: 'deepseek-v4.1-flash', messages });
  assert.equal(free.statusCode, 200);
  // Serving a free model proves the account works, so the red flag clears.
  assert.equal(context.store.account(accountId)!.quotaExhaustedAt, null);
  assert.equal(context.store.account(accountId)!.cooldownReason, null);
});

test('a quota reply on a free model parks the account for every model', async (t) => {
  const context = await fixture(t);
  context.upstream.handler = () => json({ error: { data: { code: 14018, msg: 'Credits exhausted.' } } }, 429);

  const free = await post(context, { model: 'deepseek-v4.1-flash', messages });
  assert.equal(free.statusCode, 429);
  // The upstream rejected a zero-cost model too, so the account is out for
  // everything, not just for paid models.
  const parked = context.store.accounts()[0]!;
  assert.equal(parked.quotaScope, 'account');
  assert.equal(context.store.availability(true).available, 0);
  assert.equal(context.store.availability().available, 0);

  const attempts = context.upstream.calls.length;
  const after = await post(context, { model: 'deepseek-v4.1-flash', messages });
  assert.equal(after.statusCode, 429);
  assert.equal(
    context.upstream.calls.length,
    attempts,
    'a parked account is not probed again inside the retry window',
  );
});

test('a risk-control block disables the account instead of retrying it', async (t) => {
  const context = await fixture(t);
  context.upstream.handler = () =>
    json({ error: { data: { code: 410004, msg: '账号已被封控，请联系客服' } } }, 403);
  const response = await post(context, { model: 'deepseek-v4.1-flash', messages });
  assert.equal(response.statusCode, 429);
  assert.equal(response.headers['retry-after'], '1');
  const account = context.store.accounts()[0]!;
  assert.equal(account.enabled, false);
  assert.equal(account.quotaExhaustedAt, null);
  assert.equal(context.store.availability().available, 0);
  assert.equal(context.upstream.calls.length, 1);
});

test('nested WorkBuddy error codes survive and flag quota exhaustion', async (t) => {
  const context = await fixture(t);
  context.upstream.handler = () => json({ error: { data: { code: 14018, msg: 'Credits exhausted.' } } }, 429);
  const response = await post(context, { model: 'deepseek-v4.1-flash', messages });
  assert.equal(response.statusCode, 429);
  assert.equal(response.json<{ error: { code: string } }>().error.code, 'insufficient_quota');
  assert.ok(context.store.accounts()[0]!.quotaExhaustedAt !== null);
});

test('transient upstream failures are retryable and carry a retry hint', async (t) => {
  const context = await fixture(t);
  context.upstream.handler = () =>
    new Response(JSON.stringify({ code: 500, msg: 'boom' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'retry-after': '30' },
    });
  const decorated = await post(context, { model: 'deepseek-v4.1-flash', messages });
  assert.equal(decorated.statusCode, 429);
  assert.equal(decorated.headers['retry-after'], '30');
  assert.equal(decorated.json<{ error: { code: string } }>().error.code, 'upstream_error');

  // Without a usable header the gateway still asks for a short backoff.
  context.upstream.handler = () => json({ code: 500, msg: 'boom' }, 500);
  const bare = await post(context, { model: 'deepseek-v4.1-flash', messages });
  assert.equal(bare.statusCode, 429);
  assert.equal(bare.headers['retry-after'], '1');

  // An HTTP-date is converted to a delay in seconds.
  context.upstream.handler = () =>
    new Response(JSON.stringify({ code: 429, msg: 'slow down' }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'retry-after': new Date(Date.now() + 20_000).toUTCString(),
      },
    });
  const dated = await post(context, { model: 'deepseek-v4.1-flash', messages });
  const seconds = Number(dated.headers['retry-after']);
  assert.ok(seconds >= 18 && seconds <= 20, `expected ~20s, got ${seconds}`);
});

test('protocol damage upstream is reported as a protocol error', async (t) => {
  const context = await fixture(t);
  context.upstream.handler = () => sse('data: not-json\n\n');
  const response = await post(context, { model: 'deepseek-v4.1-flash', messages });
  assert.equal(response.statusCode, 429);
  assert.equal(response.json<{ error: { code: string } }>().error.code, 'upstream_protocol_error');
});

test('a stream that fails after the status is committed emits an SSE error frame', async (t) => {
  const context = await fixture(t);
  context.upstream.handler = () => sse('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: broken\n\n');
  const response = await post(context, { model: 'deepseek-v4.1-flash', messages, stream: true });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /"code":"upstream_protocol_error"/);
  assert.equal(context.store.logs().entries[0]!.status, 429);
});

test('repeated transient failures pause the account and tell the client to wait', async (t) => {
  const context = await fixture(t);
  context.upstream.handler = () => json({ code: 500, msg: 'boom' }, 500);
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await post(context, { model: 'deepseek-v4.1-flash', messages });
    assert.equal(response.statusCode, 429);
    assert.equal(response.headers['retry-after'], '1');
  }
  // Third consecutive strike pauses the account, so the next call cannot use it.
  assert.equal(context.store.availability().available, 0);
  const paused = await post(context, { model: 'deepseek-v4.1-flash', messages });
  assert.equal(paused.statusCode, 503);
  assert.ok(Number(paused.headers['retry-after']) > 0);
});

test('no available account returns 503 with a retry hint', async (t) => {
  const context = await fixture(t);
  for (const account of context.store.accounts()) context.store.removeAccount(account.id);
  const response = await post(context, { model: 'deepseek-v4.1-flash', messages });
  assert.equal(response.statusCode, 503);
  assert.equal(context.upstream.calls.length, 0);
});

test('a quarantined account is skipped for the next request', async (t) => {
  const context = await fixture(t);
  context.store.upsertAccount({
    name: 'second',
    note: '',
    source: 'manual',
    accessToken: 'second-token-value',
    refreshToken: '',
    userId: 'user-2',
    domain: 'www.workbuddy.ai',
  });
  const tokens: Array<string | null> = [];
  context.upstream.handler = (call) => {
    tokens.push(call.headers.get('authorization'));
    return json({ code: 401, msg: 'nope' }, 401);
  };
  await post(context, { model: 'deepseek-v4.1-flash', messages });
  await post(context, { model: 'deepseek-v4.1-flash', messages });
  const distinct = new Set(tokens);
  assert.equal(distinct.size, 2, 'both accounts should have been tried before failing');
  assert.equal(context.store.availability().available, 0);
});

test('the upstream user agent and url come from runtime settings', async (t) => {
  const context = await fixture(t);
  const settings = context.store.settings();
  context.store.saveSettings({
    ...settings,
    upstream: { url: 'https://example.invalid/v2/chat/completions', userAgent: 'WorkBuddy/9.9.9' },
  });
  await post(context, { model: 'deepseek-v4.1-flash', messages });
  assert.equal(context.upstream.last!.url, 'https://example.invalid/v2/chat/completions');
  assert.equal(context.upstream.last!.headers.get('user-agent'), 'WorkBuddy/9.9.9');
  assert.equal(
    (await context.app.inject({ method: 'GET', url: '/api/admin/overview', headers: context.headers }))
      .statusCode,
    200,
  );
});

test('the health endpoints answer without authentication', async (t) => {
  const context = await fixture(t);
  assert.deepEqual((await context.app.inject({ method: 'GET', url: '/health' })).json(), {
    status: 'ok',
    version: '1.0.0',
  });
  assert.equal((await context.app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
});

test('streamed payloads from a byte-split SSE body are handled', async (t) => {
  const context = await fixture(t);
  context.upstream.handler = () => sse(streamPayload, 3);
  const response = await post(context, { model: 'deepseek-v4.1-flash', messages });
  assert.equal(response.statusCode, 200);
  assert.equal(
    response.json<{ choices: Array<{ message: { content: string } }> }>().choices[0]!.message.content,
    '你好',
  );
});
