import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ConfigParseError, EXPOSED_AGENT, parseProductConfig, toExposedModel } from '../src/catalog.js';
import { CATALOG_PATH, bundledConfig } from './helpers.js';

const config = {
  data: {
    models: [
      {
        id: 'a',
        name: 'A',
        isDefault: true,
        supportsToolCall: true,
        contextWindow: { defaultLength: 100, supportedLengths: [100, 200] },
      },
      { id: 'b', name: 'B', supportsReasoning: true },
      { id: 'hidden', name: 'Hidden' },
    ],
    agents: [{ name: 'cli', models: ['a', 'b'], modelTags: ['code'] }],
  },
};

test('a parsed model maps onto the gateway catalog entry shape', () => {
  const parsed = parseProductConfig(config);
  const first = toExposedModel(parsed.data.models[0]!);
  assert.equal(first.id, 'a');
  assert.equal(first.object, 'model');
  assert.equal(first.owned_by, 'workbuddy');
  assert.equal(first.x_workbuddy.is_default, true);
  assert.equal(first.x_workbuddy.supports_tool_call, true);
  assert.deepEqual(first.x_workbuddy.context_window?.supportedLengths, [100, 200]);
  assert.equal(toExposedModel(parsed.data.models[1]!).x_workbuddy.supports_reasoning, true);
  assert.equal(EXPOSED_AGENT, 'cli');
});

test('invalid configs fail loudly', () => {
  assert.throws(() => parseProductConfig({ data: { models: [], agents: [] } }), ConfigParseError);
  assert.throws(
    () =>
      parseProductConfig({
        data: { models: [{ id: 'a' }, { id: 'a' }], agents: [{ name: 'cli', models: ['a'] }] },
      }),
    /duplicate model id/,
  );
});

test('the bundled catalog file parses with reasoning and context metadata', () => {
  const parsed = bundledConfig();
  assert.ok(parsed.data.models.length > 0);
  const exposed = parsed.data.models.map(toExposedModel);
  assert.ok(exposed.some((model) => model.x_workbuddy.context_window !== undefined));
  assert.ok(exposed.every((model) => model.x_workbuddy.name !== undefined));
  assert.ok(parsed.data.agents.some((agent) => agent.name === EXPOSED_AGENT));
  assert.ok(readFileSync(CATALOG_PATH, 'utf8').length > 0);
});
