import { SseParser } from './stream.js';
import type { UpstreamChatRequest } from './request.js';
import { randomUUID } from 'node:crypto';
import type { WorkBuddyCredential } from './credentials.js';
import { dumpHeaders, type DumpSink } from './dump.js';
import { isAccountBlocked, isQuotaFailure } from './errors.js';

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
  /** Prompt tokens served from the upstream prompt cache. */
  cached_tokens?: number;
  /** Hidden reasoning tokens billed inside completion_tokens. */
  reasoning_tokens?: number;
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
  /** Protocol recorder; a no-op unless WKB2API_DUMP_DIR is set. */
  dump?: DumpSink;
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
  getCredential(
    apiKeyId?: string,
    needsCredits?: boolean,
    exclude?: ReadonlySet<string>,
  ): Promise<IssuedCredential>;
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

/**
 * WorkBuddy's channel verification rejects otherwise-valid chat requests with
 * `400 code:11128 request illegal` unless all three conversation headers are
 * present. The IDs are opaque to the model, so fresh UUIDs are sufficient for
 * gateway-originated turns.
 */
function conversationHeaders(): Record<string, string> {
  return {
    'X-Conversation-ID': randomUUID(),
    'X-Conversation-Request-ID': randomUUID(),
    'X-Conversation-Message-ID': randomUUID(),
  };
}

/** Thin transport over the WorkBuddy chat endpoint. Client disconnects still cancel the upstream stream. */
export class WorkBuddyClient {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: ClientOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private get dump(): DumpSink | undefined {
    return this.opts.dump?.enabled ? this.opts.dump : undefined;
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
      /** Model charges credits: skip accounts whose balance ran out. */
      needsCredits?: boolean;
      /** Accounts that already failed this client call; the pool skips them. */
      excludeAccounts?: ReadonlySet<string>;
    } = {},
  ): Promise<UpstreamStream> {
    const { apiKeyId, allowAuthRetry = true, requireDone = false, requestId } = options;
    let credential = await this.opts.credentials.getCredential(
      apiKeyId,
      options.needsCredits,
      options.excludeAccounts,
    );
    let res = await this.send(body, signal, credential, requestId);
    this.dumpResponse(res, credential, requestId, 'attempt-1');
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
        credential = await this.opts.credentials.getCredential(
          apiKeyId,
          options.needsCredits,
          options.excludeAccounts,
        );
      }
      res = await this.send(body, signal, credential, requestId);
      this.dumpResponse(res, credential, requestId, 'attempt-2');
    }
    if (res.status !== 200 || !res.body) {
      const text = await res.text().catch(() => '');
      this.dump?.write('upstream_error_body', {
        requestId,
        accountId: credential.accountId,
        status: res.status,
        retryAfter: res.headers.get('retry-after') ?? undefined,
        body: text,
      });
      const parsedBody = safeJson(text);
      const fields = errorFields(parsedBody);
      // A dead balance or a risk-control block is account-scoped and handled by
      // the pool (quota parks the account for credit-consuming models only,
      // blocked disables it). Counting them as transient strikes as well would
      // quarantine the account for every model, free ones included.
      const accountScoped =
        isAccountBlocked(fields.code, fields.message) ||
        isQuotaFailure(res.status, fields.code, fields.message);
      if (!accountScoped) {
        if (res.status === 401 || res.status === 403) this.opts.credentials.reportFailure?.(credential);
        else if (res.status >= 500 || res.status === 429)
          this.reportTransient(credential, `upstream ${res.status}`);
      }
      throw new UpstreamHttpError(
        res.status,
        fields.code,
        fields.message ?? text.slice(0, 500),
        res.headers.get('retry-after') ?? undefined,
        res.headers.get('x-request-id') ??
          (typeof parsedBody?.requestId === 'string' ? parsedBody.requestId : undefined),
        credential.accountId,
      );
    }
    const upstreamRequestId = res.headers.get('x-request-id') ?? undefined;
    return {
      credential,
      stream: this.parseStream(res.body, signal, requireDone, {
        requestId,
        accountId: credential.accountId,
      }),
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
      ...conversationHeaders(),
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
    const payload = JSON.stringify(body);
    this.dump?.write('upstream_request', {
      kind: 'credential-verification',
      url: this.url,
      method: 'POST',
      headers: dumpHeaders(headers),
      body: payload,
    });
    const res = await this.fetchFn(this.url, {
      method: 'POST',
      headers,
      body: payload,
    });
    this.dump?.write('upstream_response', {
      kind: 'credential-verification',
      status: res.status,
      statusText: res.statusText,
      headers: dumpHeaders(res.headers),
    });
    if (res.status === 200) {
      // Consume/discard whatever came back so the socket is released.
      await res.body?.cancel().catch(() => {});
      return;
    }
    // Read the failure body *before* releasing the socket, otherwise the
    // panel only ever shows "upstream 429" and the real reason is lost.
    const text = await res.text().catch(() => '');
    const parsed = safeJson(text);
    const fields = errorFields(parsed);
    throw new UpstreamHttpError(
      res.status,
      fields.code,
      fields.message ?? text.slice(0, 300),
      res.headers.get('retry-after') ?? undefined,
      res.headers.get('x-request-id') ??
        (typeof parsed?.requestId === 'string' ? parsed.requestId : undefined),
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

  /** Record the upstream status line and headers of one attempt. */
  private dumpResponse(
    res: Response,
    cred: WorkBuddyCredential,
    requestId: string | undefined,
    phase: string,
  ): void {
    this.dump?.write('upstream_response', {
      requestId,
      phase,
      accountId: (cred as IssuedCredential).accountId,
      status: res.status,
      statusText: res.statusText,
      headers: dumpHeaders(res.headers),
    });
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
      ...conversationHeaders(),
    };
    // The upstream echoes this header back (and reports it in error bodies),
    // which makes the two sides of one call traceable with a single ID.
    if (requestId) headers['X-Request-ID'] = requestId;
    const payload = JSON.stringify(body);
    this.dump?.write('upstream_request', {
      requestId,
      accountId: (cred as IssuedCredential).accountId,
      url: this.url,
      method: 'POST',
      headers: dumpHeaders(headers),
      body: payload,
    });
    return this.fetchFn(this.url, {
      method: 'POST',
      headers,
      body: payload,
      signal,
    });
  }

  /** Decode the SSE byte stream into normalized chunks. */
  private async *parseStream(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    requireDone = false,
    context: { requestId?: string; accountId?: string } = {},
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
        const text = decoder.decode(value, { stream: true });
        // Raw upstream bytes: the exact SSE text, before any parsing.
        this.dump?.write('upstream_chunk', {
          requestId: context.requestId,
          accountId: context.accountId,
          bytes: value.byteLength,
          text,
        });
        for (const frame of parser.push(text)) {
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
          // Risk-control and quota failures can also arrive as an error frame
          // after the HTTP status was already committed as 200.
          if (chunk.error) {
            const fields = errorFields(chunk);
            throw new UpstreamHttpError(
              502,
              fields.code,
              fields.message ?? 'Upstream aborted the stream.',
              undefined,
              typeof chunk.requestId === 'string' ? chunk.requestId : undefined,
              context.accountId,
            );
          }
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
            ...usageTelemetry(obj.usage),
            ...(typeof obj.usage.credit === 'number' ? { credit: obj.usage.credit } : {}),
          }
        : null,
  };
}

/**
 * The upstream reports prompt-cache usage in several dialects (OpenAI
 * \`*_tokens_details.cached_tokens\`, DeepSeek \`prompt_cache_hit_tokens\`); accept
 * any of them so the cache hit survives to the client and the log.
 */
function usageTelemetry(usage: Record<string, any>): { cached_tokens?: number; reasoning_tokens?: number } {
  const number = (...candidates: unknown[]) => {
    for (const value of candidates) if (typeof value === 'number' && Number.isFinite(value)) return value;
    return undefined;
  };
  const cached = number(
    usage.prompt_tokens_details?.cached_tokens,
    usage.input_tokens_details?.cached_tokens,
    usage.prompt_cache_hit_tokens,
    usage.cache_read_input_tokens,
    usage.cached_tokens,
  );
  const reasoning = number(
    usage.completion_tokens_details?.reasoning_tokens,
    usage.output_tokens_details?.reasoning_tokens,
    usage.completion_thinking_tokens,
  );
  return {
    ...(cached !== undefined ? { cached_tokens: cached } : {}),
    ...(reasoning !== undefined ? { reasoning_tokens: reasoning } : {}),
  };
}

/**
 * WorkBuddy nests error details (`{error:{data:{code,msg}}}`), while other
 * deployments answer flat (`{code,msg}`). Read both so upstream codes such as
 * 14018 (credits exhausted) and 410004 (account restricted) are not lost.
 */
export function errorFields(parsed: Record<string, any> | null): {
  code?: string;
  message?: string;
} {
  if (!parsed) return {};
  const nested = parsed.error && typeof parsed.error === 'object' ? parsed.error : undefined;
  const data = nested?.data && typeof nested.data === 'object' ? nested.data : undefined;
  const code = data?.code ?? nested?.code ?? parsed.code;
  const message =
    [data?.msg, nested?.msg, nested?.message, parsed.msg, parsed.message].find(
      (value): value is string => typeof value === 'string' && value.trim() !== '',
    ) ?? undefined;
  return {
    ...(code !== undefined && code !== null && code !== '' ? { code: String(code) } : {}),
    ...(message !== undefined ? { message } : {}),
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
