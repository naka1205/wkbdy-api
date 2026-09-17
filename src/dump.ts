import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { redactCredentials } from './errors.js';

/**
 * Protocol recorder for reproducing upstream/client traffic offline.
 *
 * Enabled by `WKB2API_DUMP_DIR`: every client request, upstream request and
 * upstream response byte chunk is appended to a JSONL file **verbatim** — raw
 * bodies, raw headers, raw SSE frames — so a protocol question can be answered
 * from the file instead of from a guess.
 *
 * The file therefore contains live credentials: the client API key and the
 * upstream account tokens that were in play. Treat it like a secret, keep it on
 * the machine, and delete it when the investigation is over. Set
 * `WKB2API_DUMP_REDACT=1` to store `Bearer …`/JWT/`sk-…` values as placeholders
 * instead (head names stay, so the shape is still visible).
 */
export type DumpEvent = Record<string, unknown>;

export type DumpSink = {
  readonly enabled: boolean;
  readonly dir: string;
  readonly file: string;
  write(kind: string, event: DumpEvent): void;
};

/** Safety valve only: a single agent turn can legitimately be a few MB. */
const MAX_EVENT_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024 * 1024;

const disabledSink: DumpSink = { enabled: false, dir: '', file: '', write: () => {} };

export function dumpTruncate(value: string, limit = MAX_EVENT_BYTES): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…[gateway truncated ${value.length - limit} more characters]`;
}

/** Headers exactly as they went over the wire, one `name: value` per line. */
export function dumpHeaders(headers: Headers | Record<string, unknown> | undefined): string {
  if (!headers) return '';
  const entries: Array<[string, string]> =
    headers instanceof Headers
      ? [...headers.entries()]
      : Object.entries(headers as Record<string, unknown>).map(([key, value]) => [
          key,
          Array.isArray(value) ? value.join(', ') : String(value ?? ''),
        ]);
  return entries.map(([name, value]) => `${name}: ${value}`).join('\n');
}

export function createDumpSink(dir: string | undefined, options: { redact?: boolean } = {}): DumpSink {
  if (!dir) return disabledSink;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    return disabledSink;
  }
  const file = join(dir, `dump-${new Date().toISOString().slice(0, 10)}.jsonl`);
  const cleanse = options.redact ? redactCredentials : (value: string) => value;
  let warned = false;
  return {
    enabled: true,
    dir,
    file,
    write(kind: string, event: DumpEvent): void {
      try {
        const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
        if (size > MAX_FILE_BYTES) {
          if (!warned) {
            warned = true;
            console.warn(`[dump] ${file} exceeded ${MAX_FILE_BYTES} bytes; recording stopped`);
          }
          return;
        }
        const record = { at: new Date().toISOString(), kind, ...event };
        const line = JSON.stringify(record, (_key, value) =>
          typeof value === 'string' ? cleanse(dumpTruncate(value)) : value,
        );
        appendFileSync(file, `${line}\n`, { mode: 0o600 });
      } catch {
        // Recording must never break a request.
      }
    },
  };
}
