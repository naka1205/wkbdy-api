import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, json, sse, streamPayload, API_KEY, type Fixture } from './helpers.js';

const messages = [{ role: 'user', content: 'hi' }];

const post = (context: Fixture, headers: Record<string, string> = {}, body: Record<string, unknown> = {}) =>
  context.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...context.apiHeaders, ...headers },
    payload: { model: 'deepseek-v4.1-flash', messages, ...body },
  });

test('correlation headers are echoed, forwarded upstream and logged', async (t) => {
  const context = await fixture(t);
  context.upstream.handler = () =>
    new Response(streamPayload, {
      headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'upstream-trace-1' },
    });

  const response = await post(context, {
    'x-task-id': 'task-1',
    'x-session-id': 'session-1',
    'x-zcode-trace-id': 'trace-1',
    'x-request-id': 'client-req-1',
    'x-logical-request-id': 'logical-1',
    'x-retry-attempt': '3',
  });

  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers['x-request-id']), /^[0-9a-f-]{36}$/);
  assert.equal(response.headers['x-logical-request-id'], 'logical-1');
  assert.equal(response.headers['x-task-id'], 'task-1');
  // The upstream sees one stable ID for the whole logical call.
  assert.equal(context.upstream.last!.headers.get('x-request-id'), 'logical-1');

  const entry = context.store.logs().entries[0]!;
  assert.equal(entry.taskId, 'task-1');
  assert.equal(entry.sessionId, 'session-1');
  assert.equal(entry.traceId, 'trace-1');
  assert.equal(entry.clientRequestId, 'client-req-1');
  assert.equal(entry.logicalRequestId, 'logical-1');
  assert.equal(entry.clientAttempt, 3);
  assert.equal(entry.upstreamRequestId, 'upstream-trace-1');

  const correlated = context.store.logs({ apiKeyId: entry.apiKeyId!, taskId: 'task-1' });
  assert.equal(correlated.total, 1);
  assert.equal(context.store.logs({ taskId: 'other-task' }).total, 0);
});

test('missing identifiers fall back to the gateway request id and the query-id header', async (t) => {
  const context = await fixture(t);
  const response = await post(context, { 'x-query-id': 'query-9' });
  assert.equal(response.headers['x-task-id'], 'query-9');
  // Without an explicit logical ID the gateway request ID groups the call.
  assert.equal(response.headers['x-logical-request-id'], response.headers['x-request-id']);

  const entry = context.store.logs().entries[0]!;
  assert.equal(entry.taskId, 'query-9');
  assert.equal(entry.logicalRequestId, entry.requestId);

  const plain = await post(context);
  assert.equal(plain.headers['x-task-id'], undefined);
  assert.equal(plain.headers['x-logical-request-id'], plain.headers['x-request-id']);
});

test('malformed or credential-shaped correlation headers are rejected', async (t) => {
  const context = await fixture(t);
  const malformed = await post(context, { 'x-task-id': 'has spaces' });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json<{ error: { code: string } }>().error.code, 'invalid_correlation_id');

  const tooLong = await post(context, { 'x-session-id': 'a'.repeat(129) });
  assert.equal(tooLong.statusCode, 400);

  const leaky = await post(context, { 'x-request-id': `Bearer ${API_KEY}` });
  assert.equal(leaky.statusCode, 400);
  assert.equal(leaky.json<{ error: { code: string } }>().error.code, 'invalid_correlation_id');
  assert.equal(context.upstream.calls.length, 0);
  assert.equal(context.store.logs().total, 3);
});

test('upstream trace IDs from failures are recorded on the log', async (t) => {
  const context = await fixture(t);
  context.upstream.handler = () =>
    json({ code: 11102, msg: 'service info not found' }, 500, { 'x-request-id': 'upstream-trace-2' });
  const response = await post(context, { 'x-logical-request-id': 'logical-2' });
  assert.equal(response.statusCode, 429);
  assert.equal(context.store.logs().entries[0]!.upstreamRequestId, 'upstream-trace-2');
  assert.equal(context.upstream.last!.headers.get('x-request-id'), 'logical-2');
});

test('streaming responses keep the correlation headers and log them', async (t) => {
  const context = await fixture(t);
  context.upstream.handler = () => sse(streamPayload);
  const response = await context.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...context.apiHeaders, 'x-task-id': 'task-stream', 'x-logical-request-id': 'logical-stream' },
    payload: { model: 'deepseek-v4.1-flash', messages, stream: true },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['x-task-id'], 'task-stream');
  const entry = context.store.logs().entries[0]!;
  assert.equal(entry.taskId, 'task-stream');
  assert.equal(entry.logicalRequestId, 'logical-stream');
  assert.equal(entry.stream, true);
});
