import { test } from 'node:test';
import assert from 'node:assert/strict';
import { json, sse, streamPayload, fixture, type Fixture } from './helpers.js';

const post = (context: Fixture, payload: Record<string, unknown>) =>
  context.app.inject({ method: 'POST', url: '/v1/responses', headers: context.apiHeaders, payload });

test('a non-streaming Responses request returns a completed response object', async (t) => {
  const context = await fixture(t);
  const response = await post(context, { model: 'deepseek-v4.1-flash', input: 'hello' });
  assert.equal(response.statusCode, 200);
  const body = response.json<{
    object: string;
    status: string;
    model: string;
    output: Array<{ type: string; content: Array<{ type: string; text: string }> }>;
    usage: { input_tokens: number; output_tokens: number; total_tokens: number };
  }>();
  assert.equal(body.object, 'response');
  assert.equal(body.status, 'completed');
  assert.equal(body.model, 'deepseek-v4.1-flash');
  assert.equal(body.output[0]!.type, 'message');
  assert.equal(body.output[0]!.content[0]!.text, '你好');
  assert.deepEqual(
    { input_tokens: body.usage.input_tokens, output_tokens: body.usage.output_tokens },
    { input_tokens: 10, output_tokens: 4 },
  );

  assert.deepEqual(context.upstream.last!.body.messages[0], {
    role: 'system',
    content: 'You are a helpful assistant.',
  });
  assert.equal(context.upstream.last!.body.stream, true);
});

test('instructions replace the default system prompt and output limits are enforced', async (t) => {
  const context = await fixture(t);
  await post(context, { model: 'deepseek-v4.1-flash', input: 'hello', instructions: 'Be terse.' });
  assert.deepEqual(context.upstream.last!.body.messages[0], { role: 'system', content: 'Be terse.' });

  const model = context.store.models().find((entry) => entry.x_workbuddy.max_output_tokens !== undefined);
  if (model) {
    const rejected = await post(context, {
      model: model.id,
      input: 'hello',
      max_output_tokens: (model.x_workbuddy.max_output_tokens ?? 0) + 1,
    });
    assert.equal(rejected.statusCode, 400);
  }
});

test('a streaming Responses request emits the documented event sequence', async (t) => {
  const context = await fixture(t);
  const response = await post(context, { model: 'deepseek-v4.1-flash', input: 'hello', stream: true });
  assert.equal(response.statusCode, 200);
  const events = response.body
    .split('\n\n')
    .filter((frame: string) => frame.startsWith('event: '))
    .map((frame: string) => frame.slice(7).split('\n')[0]);
  assert.equal(events[0], 'response.created');
  assert.equal(events.at(-1), 'response.completed');
  assert.ok(events.includes('response.output_text.delta'));
  assert.ok(response.body.includes('response.output_text.done'));
  assert.match(response.body, /"sequence_number":/);
});

test('invalid Responses bodies and unknown models are rejected', async (t) => {
  const context = await fixture(t);
  assert.equal((await post(context, { model: 'deepseek-v4.1-flash' })).statusCode, 400);
  assert.equal((await post(context, { model: 'nope', input: 'x' })).statusCode, 404);
  assert.equal(context.upstream.calls.length, 0);
});

test('unknown Responses fields are ignored and recorded', async (t) => {
  const context = await fixture(t);
  const response = await post(context, {
    model: 'deepseek-v4.1-flash',
    input: 'x',
    nonsense: 1,
    prompt_cache_key: 'k',
  });
  assert.equal(response.statusCode, 200);
  const entry = context.store.logs().entries[0]!;
  assert.match(entry.detail ?? '', /nonsense/);
  assert.equal(entry.endpoint, '/v1/responses');
});

test('upstream failures surface with the OpenAI error shape', async (t) => {
  const context = await fixture(t);
  context.upstream.handler = () => json({ code: 500, msg: 'boom' }, 500);
  const response = await post(context, { model: 'deepseek-v4.1-flash', input: 'x' });
  assert.equal(response.statusCode, 429);
  assert.equal(response.json<{ error: { code: string } }>().error.code, 'upstream_error');
  assert.equal(context.store.logs().entries[0]!.status, 429);
});

test('a byte-split upstream stream still produces a full response', async (t) => {
  const context = await fixture(t);
  context.upstream.handler = () => sse(streamPayload, 2);
  const response = await post(context, { model: 'deepseek-v4.1-flash', input: 'x' });
  assert.equal(
    response.json<{ output: Array<{ content: Array<{ text: string }> }> }>().output[0]!.content[0]!.text,
    '你好',
  );
});
