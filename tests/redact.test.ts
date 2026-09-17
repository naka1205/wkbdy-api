import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAccountBlocked,
  isContextOverflow,
  isCredentialFailure,
  isQuotaFailure,
  redactError,
} from '../src/errors.js';

test('known secrets never survive redaction', () => {
  const secret = 'sk-live-abcdefghijklmnop';
  const message = `upstream rejected Bearer ${secret} for user (${encodeURIComponent(secret)})`;
  const safe = redactError(message, [secret]);
  assert.ok(!safe.includes(secret));
  assert.ok(!safe.includes(encodeURIComponent(secret)));
  assert.ok(!/Bearer\s+sk-live/.test(safe));
});

test('jwt-looking values and control characters are scrubbed', () => {
  const safe = redactError('failed for eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature\u0000\u001b');
  assert.ok(!safe.includes('eyJhbGciOiJIUzI1NiJ9'));
  assert.ok(!/[\u0000-\u001f\u007f]/.test(safe));
  assert.equal(redactError('x'.repeat(1000), []).length, 400);
});

test('credential and quota failures are classified from code and message', () => {
  assert.equal(isCredentialFailure(401, undefined, undefined), true);
  assert.equal(isCredentialFailure(400, 'invalid_grant', 'nope'), true);
  assert.equal(isCredentialFailure(400, 'ok', 'fine'), false);
  assert.equal(isQuotaFailure(402, undefined, undefined), true);
  assert.equal(isQuotaFailure(429, undefined, '账户余额不足'), true);
  assert.equal(isQuotaFailure(429, undefined, 'insufficient_quota'), true);
  assert.equal(isQuotaFailure(429, undefined, 'too many requests'), false);
  // WorkBuddy's own credits-exhausted code, in the flat or nested payload.
  assert.equal(isQuotaFailure(429, '14018', 'Credits exhausted.'), true);
});

test('risk-control blocks are told apart from ordinary failures', () => {
  assert.equal(isAccountBlocked('410004', undefined), true);
  assert.equal(isAccountBlocked('14018', 'Credits exhausted.'), false);
  assert.equal(isAccountBlocked(undefined, '该账号已被封控'), true);
  assert.equal(isAccountBlocked(undefined, '账户余额不足'), false);
  assert.equal(isAccountBlocked(undefined, 'account has been suspended'), true);
});

test('context overflows are recognised from code or message', () => {
  // The spellings Codex and ZCode look for.
  assert.equal(isContextOverflow(400, 'context_length_exceeded', undefined), true);
  assert.equal(isContextOverflow(400, 'prompt_too_long', undefined), true);
  assert.equal(
    isContextOverflow(
      400,
      undefined,
      "This model's maximum context length is 65536 tokens. However, you requested 90000 tokens.",
    ),
    true,
  );
  assert.equal(
    isContextOverflow(400, undefined, 'Your input exceeds the context window of this model.'),
    true,
  );
  assert.equal(isContextOverflow(400, undefined, '输入内容过长，请减少上下文'), true);
  assert.equal(isContextOverflow(400, undefined, 'invalid function arguments'), false);
  assert.equal(isContextOverflow(500, undefined, 'context service unavailable'), false);
});
