/**
 * Incremental SSE parser for the upstream `data: {json}\n\n` stream. Frame
 * boundaries are detected from the buffered text, so the parser is independent
 * of network chunk sizes. Multi-byte UTF-8 sequences split across chunks are
 * kept in the string buffer until a complete frame arrives (frames are parsed
 * as text, so a split codepoint stays buffered with its frame).
 *
 * Upstream frames (verified in fixtures):
 *   `data: {...chat.completion.chunk...}\n\n`
 *   `data: [DONE]\n\n`  — terminal
 * 400 responses arrive as JSON, not SSE (handled by the client before parsing).
 */

export type SseFrame = { kind: 'done' } | { kind: 'data'; json: string } | { kind: 'comment'; text: string };

export class SseParser {
  private buffer = '';

  /** Feed a network chunk; returns completed frames in order. */
  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    // A frame ends at the first empty line (\n\n or \r\n\r\n or a mix).
    // The upstream uses \n\n, but CRLF tolerance is cheap and makes the
    // parser robust to proxies rewriting line endings.
    for (;;) {
      const b = this.frameBoundary();
      if (b === null) break;
      const block = this.buffer.slice(0, b.boundaryStart);
      this.buffer = this.buffer.slice(b.nextStart);
      const frame = this.parseBlock(block);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  /** Flush a trailing frame at EOF (upstream always terminates with \n\n, but
   * tolerate a stream that ends without the final blank line). */
  flush(): SseFrame[] {
    const rest = this.buffer;
    this.buffer = '';
    if (!rest.trim()) return [];
    return [this.parseBlock(rest)].filter((f): f is SseFrame => f !== null);
  }

  private frameBoundary(): { boundaryStart: number; nextStart: number } | null {
    // find "\n\n" or "\r\n\r\n" (or mixed), taking the earliest.
    const candidates: Array<[number, number]> = [];
    const nn = this.buffer.indexOf('\n\n');
    if (nn !== -1) candidates.push([nn, nn + 2]);
    const rnn = this.buffer.indexOf('\r\n\r\n');
    if (rnn !== -1) candidates.push([rnn, rnn + 4]);
    const nr = this.buffer.indexOf('\n\r');
    if (nr !== -1) candidates.push([nr, nr + 2]);
    const rn = this.buffer.indexOf('\r\n\n');
    if (rn !== -1) candidates.push([rn, rn + 3]);
    const ncr = this.buffer.indexOf('\n\r\n');
    if (ncr !== -1) candidates.push([ncr, ncr + 3]);
    if (candidates.length === 0) return null;
    // Earliest boundary in the buffer wins (offset order: [pos, len]).
    candidates.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const [pos, next] = candidates[0]!;
    return { boundaryStart: pos, nextStart: next };
  }

  private parseBlock(block: string): SseFrame | null {
    const lines = block.split(/\r\n|\r|\n/);
    const dataLines: string[] = [];
    let sawData = false;
    for (const line of lines) {
      if (line === '') continue;
      if (line.startsWith(':')) continue; // comment line
      if (line.startsWith('data:')) {
        sawData = true;
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      // Other fields (event:, id:, retry:) are not used by this upstream.
    }
    if (!sawData) {
      // comment-only block
      const comment = lines.find((l) => l.startsWith(':'));
      if (comment) return { kind: 'comment', text: comment.slice(1) };
      return null;
    }
    const data = dataLines.join('\n');
    if (data === '[DONE]') return { kind: 'done' };
    return { kind: 'data', json: data };
  }
}
