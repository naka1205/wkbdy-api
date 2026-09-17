import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SseParser, type SseFrame } from '../src/stream.js';

const framesOf = (chunks: string[]): SseFrame[] => {
  const parser = new SseParser();
  return chunks.flatMap((chunk) => parser.push(chunk));
};

test('parses frames within and across network chunks', () => {
  assert.deepEqual(framesOf(['data: {"a":1}\n\n']), [{ kind: 'data', json: '{"a":1}' }]);
  assert.deepEqual(framesOf(['data: {"a":1}\n\ndata: {"b":2}\n\n']).length, 2);
  assert.deepEqual(framesOf(['data: {"a"', ':1}\n', '\n']), [{ kind: 'data', json: '{"a":1}' }]);
  assert.deepEqual(framesOf(['data: {"a":1}\r\n\r\n']), [{ kind: 'data', json: '{"a":1}' }]);
  assert.deepEqual(framesOf([': keep-alive\n\ndata: {"a":1}\n\n']), [
    { kind: 'comment', text: ' keep-alive' },
    { kind: 'data', json: '{"a":1}' },
  ]);
  assert.deepEqual(framesOf(['data: {"a":\ndata: 1}\n\n']), [{ kind: 'data', json: '{"a":\n1}' }]);
});

test('detects the [DONE] terminal frame and flushes a trailing frame', () => {
  assert.deepEqual(framesOf(['data: [DONE]\n\n']), [{ kind: 'done' }]);
  const parser = new SseParser();
  assert.deepEqual(parser.push('data: {"a":1}\n'), []);
  assert.deepEqual(parser.flush(), [{ kind: 'data', json: '{"a":1}' }]);
  assert.deepEqual(parser.flush(), []);
});

test('keeps a multi-byte character split across chunks intact', () => {
  const buffer = Buffer.from('data: {"c":"好"}\n\n', 'utf8');
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const frames = [
    ...parser.push(decoder.decode(buffer.subarray(0, 11), { stream: true })),
    ...parser.push(decoder.decode(buffer.subarray(11), { stream: true })),
    ...parser.flush(),
  ];
  const data = frames.find((frame) => frame.kind === 'data') as { json: string };
  assert.deepEqual(JSON.parse(data.json), { c: '好' });
});
