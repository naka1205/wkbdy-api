import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSystemPrompts } from '../src/sanitize.js';

const CODEX_IDENTITY =
  'You are a coding agent running in the Codex CLI, a terminal-based coding assistant. ' +
  'Codex CLI is an open source project led by OpenAI. ' +
  'You are expected to be precise, safe, and helpful.';

test('the Codex identity paragraph is rewritten out of the system prompt', () => {
  const messages = [{ role: 'system', content: `${CODEX_IDENTITY}\n\nFollow the repo style.` }];
  const applied = sanitizeSystemPrompts(messages);
  assert.deepEqual(applied, ['codex-identity']);
  assert.equal(messages[0]!.content.includes('Codex CLI'), false);
  assert.equal(messages[0]!.content.includes('OpenAI'), false);
  // Everything after the fingerprint survives.
  assert.match(messages[0]!.content, /Follow the repo style\.$/);
});

test('the Claude Code identity sentence is rewritten too', () => {
  const messages = [{ role: 'system', content: "You are Claude Code, Anthropic's official CLI for Claude." }];
  assert.deepEqual(sanitizeSystemPrompts(messages), ['claude-code-identity']);
  assert.equal(messages[0]!.content, 'You are a terminal-based coding assistant.');

  const sdk = [
    {
      role: 'system',
      content:
        "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
    },
  ];
  assert.deepEqual(sanitizeSystemPrompts(sdk), ['claude-code-identity']);
  assert.equal(sdk[0]!.content, 'You are a terminal-based coding assistant.');
});

test('neutral prompts and non-system messages are left untouched', () => {
  const neutral = [{ role: 'system', content: 'You are a helpful assistant.' }];
  assert.deepEqual(sanitizeSystemPrompts(neutral), []);
  assert.equal(neutral[0]!.content, 'You are a helpful assistant.');

  // The same fingerprint is never rewritten inside user/tool content.
  const user = [{ role: 'user', content: CODEX_IDENTITY }];
  assert.deepEqual(sanitizeSystemPrompts(user), []);
  assert.equal(user[0]!.content, CODEX_IDENTITY);
});

test('non-string system content is ignored', () => {
  const messages = [{ role: 'system', content: [{ type: 'text', text: CODEX_IDENTITY }] }];
  assert.deepEqual(sanitizeSystemPrompts(messages), []);
});
