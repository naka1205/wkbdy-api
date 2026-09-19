import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapResponsesRequest, ResponsesInputError } from '../src/openai/responses-request-mapper.js';
import { fixture, sse, type Fixture } from './helpers.js';

/** The item shapes Codex 0.154 sends (captured from a real request). */
const codexBody = (overrides: Record<string, unknown> = {}) => ({
  model: 'deepseek-v4.1-flash',
  stream: true,
  tool_choice: 'auto',
  parallel_tool_calls: false,
  input: [
    {
      type: 'additional_tools',
      id: 'at_1',
      role: 'developer',
      tools: [
        {
          type: 'namespace',
          name: 'functions',
          description: '',
          tools: [
            { type: 'custom', name: 'exec', description: 'Run JavaScript', format: { type: 'grammar' } },
            {
              type: 'function',
              name: 'wait',
              description: 'Wait for a cell',
              parameters: { type: 'object', properties: { cell_id: { type: 'string' } } },
              strict: false,
            },
          ],
        },
        {
          type: 'function',
          name: 'sleep',
          description: 'Sleep',
          parameters: { type: 'object', properties: {} },
        },
      ],
    },
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'be nice' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque' },
  ],
  ...overrides,
});

const post = (context: Fixture, payload: Record<string, unknown>) =>
  context.app.inject({ method: 'POST', url: '/v1/responses', headers: context.apiHeaders, payload });

test('Codex additional_tools are flattened into upstream function tools', () => {
  const mapping = mapResponsesRequest(codexBody() as never);
  const names = mapping.tools.map((tool) => (tool as { function: { name: string } }).function.name);
  assert.deepEqual(names, ['exec', 'wait', 'sleep']);
  assert.deepEqual([...mapping.customTools], ['exec']);
  const exec = mapping.tools[0] as { function: { parameters: { required: string[] } } };
  assert.deepEqual(exec.function.parameters.required, ['input']);
  assert.deepEqual(mapping.ignored, ['input.3:reasoning']);
  assert.deepEqual(
    mapping.upstream.messages.map((message) => message.role),
    ['system', 'system', 'user'],
  );
});

test('unknown input items are ignored instead of failing the turn', async (t) => {
  const context = await fixture(t);
  const response = await post(
    context,
    codexBody({ input: [...codexBody().input, { type: 'brand_new_item' }] }),
  );
  assert.equal(response.statusCode, 200);
  const entry = context.store.logs().entries[0]!;
  assert.match(entry.detail ?? '', /brand_new_item/);
  assert.equal(context.upstream.calls.length, 1);
});

test('a freeform tool call comes back as custom_tool_call', async (t) => {
  const context = await fixture(t);
  context.upstream.handler = () =>
    sse(
      `data: ${JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'exec', arguments: '{"input":"console.log(1)"}' },
                },
              ],
            },
          },
        ],
      })}\n\n` +
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        })}\n\n` +
        'data: [DONE]\n\n',
    );
  const response = await post(context, codexBody({ stream: false }));
  assert.equal(response.statusCode, 200);
  const body = response.json<{ output: Array<Record<string, unknown>> }>();
  assert.equal(body.output[0]!.type, 'custom_tool_call');
  assert.equal(body.output[0]!.name, 'exec');
  assert.equal(body.output[0]!.input, 'console.log(1)');

  // The tool we declared upstream is a function with a single string argument.
  const sent = context.upstream.last!.body;
  assert.equal(sent.tools[0].function.name, 'exec');
  assert.deepEqual(sent.tools[0].function.parameters.required, ['input']);
});

test('a streaming freeform call emits the custom input event', async (t) => {
  const context = await fixture(t);
  context.upstream.handler = () =>
    sse(
      `data: ${JSON.stringify({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_9',
                  type: 'function',
                  function: { name: 'exec', arguments: '{"input":"1+1"}' },
                },
              ],
            },
          },
        ],
      })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n` +
        'data: [DONE]\n\n',
    );
  const response = await post(context, codexBody());
  assert.match(response.body, /response.custom_tool_call_input.done/);
  assert.match(response.body, /"type":"custom_tool_call"/);
  assert.ok(!response.body.includes('response.function_call_arguments.delta'));
});

test('every streamed event reuses the ItemDone item id', async (t) => {
  const context = await fixture(t);
  context.upstream.handler = () =>
    sse(
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { content: 'thinking' }, finish_reason: null }],
      })}\n\n` +
        `data: ${JSON.stringify({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_5',
                    type: 'function',
                    function: { name: 'exec', arguments: '{"input":"1+1"}' },
                  },
                ],
              },
            },
          ],
        })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n` +
        'data: [DONE]\n\n',
    );
  const response = await post(context, codexBody());
  const frames = response.body
    .split('\n\n')
    .filter((frame) => frame.startsWith('event: '))
    .map((frame) => {
      const [, data] = frame.split('\ndata: ');
      return JSON.parse(data!) as Record<string, never>;
    });
  const added = frames.filter((frame) => frame.type === 'response.output_item.added');
  const dones = frames.filter((frame) => frame.type === 'response.output_item.done');
  assert.equal(added.length, 2);
  assert.equal(dones.length, 2);
  for (const [index, done] of dones.entries()) {
    assert.equal(
      (done.item as unknown as { id: string }).id,
      (added[index]!.item as unknown as { id: string }).id,
    );
  }
  const customDone = frames.find((frame) => frame.type === 'response.custom_tool_call_input.done')!;
  const toolDone = dones[1]!;
  assert.equal(customDone.item_id, (toolDone.item as unknown as { id: string }).id);
});

test('custom tool call history round-trips', () => {
  const mapping = mapResponsesRequest(
    codexBody({
      input: [
        {
          type: 'custom_tool_call',
          call_id: 'call_7',
          name: 'exec',
          input: 'console.log(2)',
        },
        { type: 'custom_tool_call_output', call_id: 'call_7', output: '2' },
      ],
    }) as never,
  );
  const assistant = mapping.upstream.messages.find((message) => message.role === 'assistant') as unknown as {
    tool_calls: Array<{ id: string; function: { name: string; arguments: string } }>;
  };
  assert.equal(assistant.tool_calls[0]!.id, 'call_7');
  assert.equal(assistant.tool_calls[0]!.function.name, 'exec');
  assert.equal(assistant.tool_calls[0]!.function.arguments, 'console.log(2)');
  const tool = mapping.upstream.messages.find((message) => message.role === 'tool') as unknown as {
    content: string;
    tool_call_id: string;
  };
  assert.equal(tool.content, '2');
  assert.equal(tool.tool_call_id, 'call_7');
});

test('a malformed message item still reports its path', () => {
  assert.throws(
    () =>
      mapResponsesRequest({
        ...codexBody(),
        input: [{ type: 'message', role: 'nope', content: 'x' }],
      } as never),
    (error: unknown) =>
      error instanceof ResponsesInputError &&
      error.path === 'input.0.role' &&
      /Unsupported/.test(error.message),
  );
});

test('parallel tool calls share one assistant message', () => {
  const mapping = mapResponsesRequest({
    model: 'deepseek-v4.1-flash',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run both' }] },
      { type: 'function_call', call_id: 'call_00', name: 'exec_command', arguments: '{"cmd":"ls"}' },
      { type: 'function_call', call_id: 'call_01', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
      { type: 'function_call_output', call_id: 'call_00', output: 'file1' },
      { type: 'function_call_output', call_id: 'call_01', output: '/tmp' },
    ],
  } as never);

  // The upstream answers "tool calls and tool results do not match" when a
  // parallel call is split into two assistant messages.
  assert.deepEqual(
    mapping.upstream.messages.map((message) => message.role),
    ['system', 'user', 'assistant', 'tool', 'tool'],
  );
  const assistant = mapping.upstream.messages[2] as unknown as {
    tool_calls: Array<{ id: string; function: { name: string } }>;
  };
  assert.deepEqual(
    assistant.tool_calls.map((call) => call.id),
    ['call_00', 'call_01'],
  );
});

test('an assistant message between calls starts a new tool-call message', () => {
  const mapping = mapResponsesRequest({
    model: 'deepseek-v4.1-flash',
    input: [
      { type: 'function_call', call_id: 'call_00', name: 'exec_command', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_00', output: 'ok' },
      { type: 'function_call', call_id: 'call_01', name: 'exec_command', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_01', output: 'ok' },
    ],
  } as never);

  assert.deepEqual(
    mapping.upstream.messages.map((message) => message.role),
    ['system', 'assistant', 'tool', 'assistant', 'tool'],
  );
});

test('an assistant text message and its tool calls become one message', () => {
  const mapping = mapResponsesRequest({
    model: 'deepseek-v4.1-flash',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run ls' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Listing now.' }] },
      { type: 'function_call', call_id: 'call_00', name: 'exec_command', arguments: '{"cmd":"ls"}' },
      { type: 'function_call', call_id: 'call_01', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
      { type: 'function_call_output', call_id: 'call_00', output: 'file1' },
      { type: 'function_call_output', call_id: 'call_01', output: '/tmp' },
    ],
  } as never);

  // Split into two assistant messages the upstream rejects the whole turn with
  // "the reasoning content from the previous turn must be passed back".
  assert.deepEqual(
    mapping.upstream.messages.map((message) => message.role),
    ['system', 'user', 'assistant', 'tool', 'tool'],
  );
  const assistant = mapping.upstream.messages[2] as unknown as {
    content: string;
    tool_calls: Array<{ id: string }>;
  };
  assert.equal(assistant.content, 'Listing now.');
  assert.deepEqual(
    assistant.tool_calls.map((call) => call.id),
    ['call_00', 'call_01'],
  );
});

test('a second assistant turn after tool results starts a new message', () => {
  const mapping = mapResponsesRequest({
    model: 'deepseek-v4.1-flash',
    input: [
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'first' }] },
      { type: 'function_call', call_id: 'call_00', name: 'exec_command', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_00', output: 'ok' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'second' }] },
      { type: 'function_call', call_id: 'call_01', name: 'exec_command', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_01', output: 'ok' },
    ],
  } as never);

  assert.deepEqual(
    mapping.upstream.messages.map((message) => message.role),
    ['system', 'assistant', 'tool', 'assistant', 'tool'],
  );
});
