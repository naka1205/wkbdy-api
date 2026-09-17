import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SYSTEM_PROMPT,
  chatRequestSchema,
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

test('a strict request schema rejects unknown fields', () => {
  assert.throws(() => parse({ model: 'm', messages: [{ role: 'user', content: 'x' }], n: 2 }));
  assert.throws(() => parse({ model: 'm', messages: [] }));
});

test('"[undefined]" placeholders from loose clients are dropped', () => {
  const body = normalizeOpenAiRequestBody({
    model: 'm',
    temperature: '[undefined]',
    stream_options: { include_usage: '[undefined]' },
  });
  assert.deepEqual(body, { model: 'm', stream_options: {} });
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
      { finish_reason: 'stop', usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } },
    ),
  );
  const built = aggregator.build('m');
  assert.equal(built.object, 'chat.completion');
  assert.equal(built.model, 'm');
  assert.deepEqual(built.choices[0]?.message, { role: 'assistant', content: '你好' });
  assert.equal(built.choices[0]?.finish_reason, 'stop');
  assert.deepEqual(built.usage, { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
});
