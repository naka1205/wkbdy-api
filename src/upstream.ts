import { SseParser } from './stream.js';
import type { UpstreamChatRequest } from './request.js';
import { randomUUID } from 'node:crypto';
import type { WorkBuddyCredential } from './credentials.js';

/** One normalized upstream chunk event, post-SSE parsing. */
export type UpstreamChunk = {
  id?: string;
  model?: string;
  created?: number;
  delta: {
    role?: string;
    content?: string;
    reasoning_content?: string;
    tool_calls?: Array<{
      index?: number;
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>;
  };
  finish_reason: string | null; // upstream uses '' for "in progress"
  usage: UpstreamUsage | null;
};

export type UpstreamUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** WorkBuddy extension: credits charged for this request. */
  credit?: number;
};

export type StreamResult = AsyncGenerator<UpstreamChunk, void, void>;

export type ClientOptions = {
  /** Static value or getter, so runtime settings changes take effect immediately. */
  upstreamUrl: string | (() => string);
  credentials: CredentialLike;
  userAgent: string | (() => string);
  fetchFn?: typeof fetch;
};

/**
 * A credential plus the account row it came from, so failures and usage stay
 * attributable to one account.
 */
export type IssuedCredential = WorkBuddyCredential & { accountId?: string; label?: string };

/**
 * Credential surface the client needs. The account service implements it;
 * failures are reported back so a dead account can be quarantined.
 */
export type CredentialLike = {
  /** `apiKeyId` selects the sticky assignment when the pool pins keys. */
  getCredential(apiKeyId?: string): Promise<IssuedCredential>;
  invalidate(): void;
  describe(): string;
  reportFailure?(credential: IssuedCredential): void;
  /** Transient upstream failure: the pool decides when it warrants a pause. */
  reportTransientFailure?(accountId: string | undefined, message?: string): void;
  refreshRejectedCredential?(credential: IssuedCredential): Promise<IssuedCredential>;
};

/**
 * Upstream `Retry-After` in seconds: either a delay in seconds or an HTTP date.
 * Values are clamped to a day so a broken header cannot park a client forever.
 */
export function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (value == null || value.trim() === '') return undefined;
  const raw = value.trim();
  const seconds = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : (Date.parse(raw) - Date.now()) / 1000;
  if (!Number.isFinite(seconds)) return undefined;
  return Math.max(0, Math.min(86400, Math.ceil(seconds)));
}

/** Upstream 4xx/5xx surfaced as a typed error with the upstream status. */
export class UpstreamHttpError extends Error {
  /** Upstream `Retry-After` translated to seconds, when the header was usable. */
  readonly retryAfterSeconds?: number;
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    public readonly upstreamMessage: string,
    public readonly retryAfter?: string,
    /** Upstream trace ID from the `x-request-id` header or the error body. */
    public readonly requestId?: string,
    /** Account the failing call used, so the pool can retire it. */
    public readonly accountId?: string,
  ) {
    super(`upstream ${status}`);
    this.name = 'UpstreamHttpError';
    this.retryAfterSeconds = parseRetryAfter(retryAfter);
  }
}

export class UpstreamProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamProtocolError';
  }
}

/**
 * Result of opening an upstream stream: the account used, the decoded stream
 * and the upstream-side trace ID (an echo of the `X-Request-ID` we send).
 */
export type UpstreamStream = {
  credential: IssuedCredential;
  stream: StreamResult;
  upstreamRequestId?: string;
};

/** Thin transport over the WorkBuddy chat endpoint. Client disconnects still cancel the upstream stream. */
export class WorkBuddyClient {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: ClientOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private get url(): string {
    return typeof this.opts.upstreamUrl === 'function' ? this.opts.upstreamUrl() : this.opts.upstreamUrl;
  }

  private get userAgent(): string {
    return typeof this.opts.userAgent === 'function' ? this.opts.userAgent() : this.opts.userAgent;
  }

  /**
   * Open the upstream stream. Always sends stream:true (upstream rejects
   * non-stream). On 401/403 the failing account is reported (pool quarantines
   * it), the credential is re-picked — which for a pool means the NEXT
   * account — and the request retried once; a second failure surfaces.
   */
  async streamChatCompletion(
    body: UpstreamChatRequest,
    signal: AbortSignal,
    options: {
      apiKeyId?: string;
      allowAuthRetry?: boolean;
      requireDone?: boolean;
      /** Correlation ID echoed by the upstream as `x-request-id`. */
      requestId?: string;
    } = {},
  ): Promise<UpstreamStream> {
    const { apiKeyId, allowAuthRetry = true, requireDone = false, requestId } = options;
    let credential = await this.opts.credentials.getCredential(apiKeyId);
    let res = await this.send(body, signal, credential, requestId);
    if (res.status === 401 && allowAuthRetry) {
      await res.body?.cancel().catch(() => {});
      if (this.opts.credentials.refreshRejectedCredential) {
        try {
          credential = await this.opts.credentials.refreshRejectedCredential(credential);
        } catch {
          throw new UpstreamHttpError(401, undefined, 'Account needs a new web login.');
        }
      } else {
        this.opts.credentials.invalidate();
        credential = await this.opts.credentials.getCredential(apiKeyId);
      }
      res = await this.send(body, signal, credential, requestId);
    }
    if (res.status === 401 || res.status === 403) this.opts.credentials.reportFailure?.(credential);
    else if (res.status >= 500 || res.status === 429)
      this.reportTransient(credential, `upstream ${res.status}`);
    if (res.status !== 200 || !res.body) {
      const text = await res.text().catch(() => '');
      const parsed = safeJson(text);
      throw new UpstreamHttpError(
        res.status,
        parsed?.code !== undefined ? String(parsed.code) : undefined,
        typeof parsed?.msg === 'string' ? parsed.msg : text.slice(0, 500),
        res.headers.get('retry-after') ?? undefined,
        res.headers.get('x-request-id') ??
          (typeof parsed?.requestId === 'string' ? parsed.requestId : undefined),
        credential.accountId,
      );
    }
    const upstreamRequestId = res.headers.get('x-request-id') ?? undefined;
    return {
      credential,
      stream: this.parseStream(res.body, signal, requireDone),
      ...(upstreamRequestId ? { upstreamRequestId } : {}),
    };
  }

  /**
   * Verify a candidate credential against the upstream before the admin
   * panel switches to it. Minimal request: one user message, one token of
   * expected output. Throws UpstreamHttpError on rejection — caller maps it.
   * Does NOT touch the provider's active credential.
   */
  async verifyCredential(cred: { accessToken: string; userId: string }): Promise<void> {
    const domain = 'www.workbuddy.ai';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${cred.accessToken}`,
      'X-User-Id': cred.userId,
      'X-Domain': domain,
      'X-Product': 'SaaS',
      'X-Request-ID': randomUUID(),
      'User-Agent': this.userAgent,
    };
    const body: UpstreamChatRequest = {
      model: 'deepseek-v4.1-flash',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Reply with OK only.' },
      ],
      stream: true,
      max_tokens: 5,
    };
    const res = await this.fetchFn(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    // Consume/discard whatever came back so the socket is released.
    await res.body?.cancel().catch(() => {});
    if (res.status === 200) return;
    const text = await res.text().catch(() => '');
    const parsed = safeJson(text);
    throw new UpstreamHttpError(
      res.status,
      parsed?.code !== undefined ? String(parsed.code) : undefined,
      typeof parsed?.msg === 'string' ? parsed.msg : text.slice(0, 300),
    );
  }

  /**
   * Send one attempt, translating a connection-level failure (DNS, reset,
   * timeout) into a retryable error while still reporting it to the pool.
   */
  private async send(
    body: UpstreamChatRequest,
    signal: AbortSignal,
    cred: WorkBuddyCredential,
    requestId?: string,
  ): Promise<Response> {
    try {
      return await this.attempt(body, signal, cred, requestId);
    } catch (error) {
      if (!(error instanceof Error) || error.name === 'AbortError') throw error;
      this.reportTransient(cred, error.message);
      throw error;
    }
  }

  private reportTransient(cred: WorkBuddyCredential, message: string): void {
    const accountId = (cred as IssuedCredential).accountId;
    this.opts.credentials.reportTransientFailure?.(accountId, message);
  }

  private async attempt(
    body: UpstreamChatRequest,
    signal: AbortSignal,
    cred: WorkBuddyCredential,
    requestId?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${cred.accessToken}`,
      'X-User-Id': cred.userId,
      'X-Domain': cred.domain,
      'X-Product': 'SaaS',
      'User-Agent': this.userAgent,
    };
    // The upstream echoes this header back (and reports it in error bodies),
    // which makes the two sides of one call traceable with a single ID.
    if (requestId) headers['X-Request-ID'] = requestId;
    return this.fetchFn(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
  }

  /** Decode the SSE byte stream into normalized chunks. */
  private async *parseStream(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    requireDone = false,
  ): StreamResult {
    const reader = body.getReader();
    const onAbort = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const decoder = new TextDecoder('utf-8');
    const parser = new SseParser();
    let done = false;
    try {
      while (!done) {
        signal.throwIfAborted();
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          if (frame.kind === 'done') {
            done = true;
            break;
          }
          if (frame.kind === 'comment') continue;
          const chunk = safeJson(frame.json);
          if (chunk === null) {
            throw new UpstreamProtocolError(
              `upstream sent a non-JSON SSE frame: ${frame.json.slice(0, 200)}`,
            );
          }
          yield normalizeChunk(chunk);
        }
      }
      if (!done) {
        // EOF before [DONE]: tolerate trailing frames, but note them.
        for (const frame of parser.flush()) {
          if (frame.kind === 'done') {
            done = true;
            break;
          }
          if (frame.kind === 'comment') continue;
          const chunk = safeJson(frame.json);
          if (chunk === null) throw new UpstreamProtocolError('upstream sent a non-JSON trailing frame');
          yield normalizeChunk(chunk);
        }
      }
      signal.throwIfAborted();
      if (requireDone && !done) throw new UpstreamProtocolError('Upstream stream ended without [DONE].');
    } finally {
      signal.removeEventListener('abort', onAbort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}

/** Map a raw upstream chunk JSON onto UpstreamChunk, tolerating shape drift. */
function normalizeChunk(raw: unknown): UpstreamChunk {
  const obj = (raw ?? {}) as Record<string, any>;
  const choice = obj.choices?.[0] ?? {};
  const delta = choice.delta ?? {};
  const finishRaw = choice.finish_reason;
  return {
    id: typeof obj.id === 'string' ? obj.id : undefined,
    model: typeof obj.model === 'string' ? obj.model : undefined,
    created: typeof obj.created === 'number' ? obj.created : undefined,
    delta: {
      role: typeof delta.role === 'string' ? delta.role : undefined,
      content: typeof delta.content === 'string' ? delta.content : undefined,
      reasoning_content: typeof delta.reasoning_content === 'string' ? delta.reasoning_content : undefined,
      tool_calls: Array.isArray(delta.tool_calls) ? delta.tool_calls : undefined,
    },
    finish_reason: typeof finishRaw === 'string' && finishRaw !== '' ? finishRaw : null,
    usage:
      obj.usage && typeof obj.usage === 'object' && obj.usage.prompt_tokens !== undefined
        ? {
            prompt_tokens: obj.usage.prompt_tokens,
            completion_tokens: obj.usage.completion_tokens,
            total_tokens: obj.usage.total_tokens,
            ...(typeof obj.usage.credit === 'number' ? { credit: obj.usage.credit } : {}),
          }
        : null,
  };
}

function safeJson(text: string): Record<string, any> | null {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}
