import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SYSTEM_PROMPT,
  chatRequestSchema,
  ignoredRequestFields,
  mapThinkingToReasoningEffort,
  normalizeMessages,
  normalizeOpenAiRequestBody,
  toUpstreamRequest,
} from '../src/request.js';
import { CompletionAggregator, toOpenAiChunk } from '../src/openai/response-builder.js';
import type { UpstreamChunk } from '../src/upstream.js';

const parse = (body: Record<string, unknown>) => chatRequestSchema.parse(body);
const chunk = (delta: UpstreamChunk['delta'], rest: Partial<UpstreamChunk> = {}): UpstreamChunk => ({
  delta,
  finish_reason: null,
  usage: null,
  ...rest,
});

test('the upstream request always streams and always starts with a system message', () => {
  const request = parse({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: false });
  const upstream = toUpstreamRequest(request);
  assert.equal(upstream.stream, true);
  assert.deepEqual(upstream.messages[0], { role: 'system', content: DEFAULT_SYSTEM_PROMPT });
  assert.deepEqual(upstream.messages[1], { role: 'user', content: 'hi' });

  const withSystem = parse({
    model: 'm',
    messages: [
      { role: 'system', content: 'custom' },
      { role: 'user', content: 'hi' },
    ],
  });
  assert.equal(toUpstreamRequest(withSystem).messages.length, 2);
  assert.deepEqual(
    normalizeMessages(parse({ model: 'm', messages: [{ role: 'developer', content: 'd' }] }).messages)[0],
    {
      role: 'system',
      content: 'd',
    },
  );
});

test('max_completion_tokens becomes upstream max_tokens and reasoning is mapped', () => {
  assert.equal(
    toUpstreamRequest(
      parse({ model: 'm', messages: [{ role: 'user', content: 'x' }], max_completion_tokens: 123 }),
    ).max_tokens,
    123,
  );
  assert.equal(
    toUpstreamRequest(
      parse({ model: 'm', messages: [{ role: 'user', content: 'x' }], reasoning_effort: 'low' }),
    ).reasoning_effort,
    'low',
  );
  assert.equal(mapThinkingToReasoningEffort({ type: 'disabled' }), 'none');
  assert.equal(mapThinkingToReasoningEffort({ type: 'enabled', budget_tokens: 1000 }), 'low');
  assert.equal(mapThinkingToReasoningEffort({ type: 'enabled', budget_tokens: 40_000 }), 'xhigh');
  assert.equal(mapThinkingToReasoningEffort({ type: 'adaptive' }, 'medium'), 'medium');
});

test('unknown fields are stripped instead of rejected', () => {
  // A newer OpenAI field, or a provider-specific extra, must not cost the
  // client its whole turn.
  const parsed = parse({
    model: 'm',
    messages: [{ role: 'user', content: 'x' }],
    n: 2,
    response_format: { type: 'json_object' },
    prompt_cache_key: 'abc',
  });
  assert.deepEqual(Object.keys(parsed).sort(), ['messages', 'model', 'stream']);
  assert.deepEqual(ignoredRequestFields({ model: 'm', messages: [], prompt_cache_key: 'a' }), [
    'prompt_cache_key',
  ]);

  assert.throws(() => parse({ model: 'm', messages: [] }));
  assert.throws(() => parse({ model: '', messages: [{ role: 'user', content: 'x' }] }));
});

test('a tool-calling assistant turn may carry null content', () => {
  // OpenAI's canonical shape for "assistant called tools, no prose", and what
  // ZCode sends mid-conversation.
  const request = parse({
    model: 'm',
    messages: [
      { role: 'user', content: 'run it' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
    ],
  });
  const upstream = toUpstreamRequest(request);
  const assistant = upstream.messages.find((message) => message.role === 'assistant') as unknown as {
    content: unknown;
    tool_calls: unknown[];
  };
  assert.equal(assistant.content, null);
  assert.equal(assistant.tool_calls.length, 1);
});

test('legacy function-role messages still parse', () => {
  const request = parse({
    model: 'm',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'function', name: 'lookup', content: '{}' },
    ],
  });
  assert.equal(request.messages[1]!.role, 'function');
});

test('fields dropped from inside a message are reported', () => {
  assert.deepEqual(
    ignoredRequestFields({
      model: 'm',
      messages: [{ role: 'assistant', content: 'x', function_call: { name: 'f', arguments: '{}' } }],
    }),
    ['messages[0].function_call'],
  );
});

test('"[undefined]" placeholders from loose clients are dropped', () => {
  const body = normalizeOpenAiRequestBody({
    model: 'm',
    temperature: '[undefined]',
    // Not in any allow-list: the placeholder is dropped by value, not by name.
    prompt_cache_key: '[undefined]',
    stream_options: { include_usage: '[undefined]', other: 1 },
  });
  assert.deepEqual(body, { model: 'm', stream_options: { other: 1 } });
});

test('streaming chunks drop upstream shell fields', () => {
  const meta = { id: 'chatcmpl-1', created: 1, model: 'm' };
  const converted = toOpenAiChunk(
    chunk({ role: 'assistant', content: 'hi', reasoning_content: 'think' }),
    meta,
  );
  assert.deepEqual(converted?.choices[0]?.delta, {
    role: 'assistant',
    content: 'hi',
    reasoning_content: 'think',
  });
  assert.equal(toOpenAiChunk(chunk({ tool_calls: [{ index: 0, function: {} }] }), meta), null);
  assert.equal(toOpenAiChunk(chunk({}, { finish_reason: 'stop' }), meta)?.choices[0]?.finish_reason, 'stop');
});

test('the aggregator builds a complete completion with usage', () => {
  const aggregator = new CompletionAggregator();
  aggregator.push(chunk({ role: 'assistant', content: '你' }));
  aggregator.push(chunk({ content: '好' }));
  aggregator.push(
    chunk(
      {},
      {
        finish_reason: 'stop',
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4,
          total_tokens: 14,
          cached_tokens: 8,
          reasoning_tokens: 3,
        },
      },
    ),
  );
  const built = aggregator.build('m');
  assert.equal(built.object, 'chat.completion');
  assert.equal(built.model, 'm');
  assert.deepEqual(built.choices[0]?.message, { role: 'assistant', content: '你好' });
  assert.equal(built.choices[0]?.finish_reason, 'stop');
  assert.deepEqual(built.usage, {
    prompt_tokens: 10,
    completion_tokens: 4,
    total_tokens: 14,
    prompt_tokens_details: { cached_tokens: 8 },
    completion_tokens_details: { reasoning_tokens: 3 },
  });
});

test('an assistant text message and its tool calls are folded into one message', () => {
  const request = parse({
    model: 'm',
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'run ls' },
      { role: 'assistant', content: 'Listing now.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_00', type: 'function', function: { name: 'exec', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_00', content: 'file1' },
    ],
  });
  const messages = toUpstreamRequest(request).messages;
  assert.deepEqual(
    messages.map((message) => message.role),
    ['system', 'user', 'assistant', 'tool'],
  );
  assert.equal(messages[2]!.content, 'Listing now.');
  assert.deepEqual(
    (messages[2] as unknown as { tool_calls: Array<{ id: string }> }).tool_calls.map((call) => call.id),
    ['call_00'],
  );
});
