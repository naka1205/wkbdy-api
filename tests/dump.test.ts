import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDumpSink, dumpHeaders } from '../src/dump.js';
import { fixture } from './helpers.js';

const readLines = (dir: string) => {
  const file = readFileSync(join(dir, `dump-${new Date().toISOString().slice(0, 10)}.jsonl`), 'utf8');
  return file
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, any>);
};

test('the sink is inert until a directory is configured', () => {
  const sink = createDumpSink(undefined);
  assert.equal(sink.enabled, false);
  sink.write('anything', { a: 1 });
});

test('records raw values, and only redacts on request', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wkbdy-dump-'));
  const raw = createDumpSink(dir);
  raw.write('client_request', { headers: dumpHeaders({ authorization: 'Bearer sk-wk-secret-12345678' }) });
  const [entry] = readLines(dir);
  assert.match(String(entry!.headers), /Bearer sk-wk-secret-12345678/);
  rmSync(dir, { recursive: true, force: true });

  const redactedDir = mkdtempSync(join(tmpdir(), 'wkbdy-dump-redacted-'));
  createDumpSink(redactedDir, { redact: true }).write('client_request', {
    headers: dumpHeaders({ authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig' }),
  });
  const [redacted] = readLines(redactedDir);
  assert.match(String(redacted!.headers), /Bearer \[redacted\]/);
  rmSync(redactedDir, { recursive: true, force: true });
});

test('a chat completion records client, upstream and frame level data', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wkbdy-dump-live-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const context = await fixture(t, { env: { dumpDir: dir } });

  const response = await context.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: { ...context.apiHeaders, 'x-task-id': 'zcode-task-9' },
    payload: {
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'hi' }],
      prompt_cache_key: 'cache-9',
    },
  });
  assert.equal(response.statusCode, 200);

  const entries = readLines(dir);
  const kinds = entries.map((entry) => entry.kind);
  assert.ok(kinds.includes('client_request'));
  assert.ok(kinds.includes('upstream_request'));
  assert.ok(kinds.includes('upstream_response'));
  assert.ok(kinds.includes('upstream_chunk'));
  assert.ok(kinds.includes('client_response'));

  const clientRequest = entries.find((entry) => entry.kind === 'client_request')!;
  assert.equal(clientRequest.method, 'POST');
  assert.match(String(clientRequest.headers), /x-task-id: zcode-task-9/);
  // The raw body survives, including the field the gateway ignores.
  assert.match(String(clientRequest.body), /"prompt_cache_key":"cache-9"/);

  const upstreamRequest = entries.find((entry) => entry.kind === 'upstream_request')!;
  assert.match(String(upstreamRequest.url), /\/v2\/chat\/completions$/);
  assert.match(String(upstreamRequest.headers), /x-user-id: user-1/i);
  assert.match(String(upstreamRequest.headers), /authorization: bearer test-access-token-value/i);

  const frames = entries.filter((entry) => entry.kind === 'upstream_chunk');
  assert.match(frames.map((frame) => frame.text).join(''), /data: \[DONE\]/);
  const upstreamResponse = entries.find((entry) => entry.kind === 'upstream_response')!;
  assert.equal(upstreamResponse.status, 200);
});

test('a streaming request records the frames the client receives', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wkbdy-dump-stream-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const context = await fixture(t, { env: { dumpDir: dir } });

  const response = await context.app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: context.apiHeaders,
    payload: { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }], stream: true },
  });
  assert.equal(response.statusCode, 200);

  const frames = readLines(dir).filter((entry) => entry.kind === 'client_sse');
  const text = frames.map((frame) => frame.text).join('');
  assert.match(text, /chat.completion.chunk/);
  assert.match(text, /data: \[DONE\]/);
});
