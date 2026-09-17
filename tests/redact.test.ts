import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCredentialFailure, isQuotaFailure, redactError } from '../src/errors.js';

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
});
