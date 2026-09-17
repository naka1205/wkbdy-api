import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  chatRequestSchema,
  ignoredRequestFields,
  normalizeOpenAiRequestBody,
  toUpstreamRequest,
} from './request.js';
import {
  UpstreamHttpError,
  UpstreamProtocolError,
  type WorkBuddyClient,
  type IssuedCredential,
  type UpstreamStream,
  type UpstreamUsage,
} from './upstream.js';
import {
  CompletionAggregator,
  localCompletionId,
  toOpenAiChunk,
  toOpenAiUsage,
} from './openai/response-builder.js';
import { openAiError } from './openai/errors.js';
import { modelConsumesCredits, resolvedContextWindow, type StoredModel } from './models.js';
import type { Accounts } from './accounts.js';
import {
  AppError,
  CredentialError,
  NoAvailableAccountsError,
  isAccountBlocked,
  isContextOverflow,
  isQuotaFailure,
  redactError,
} from './errors.js';
import { requestRecorder, type RequestOutcome } from './logging.js';
import {
  applyCorrelation,
  correlationHeaders,
  resolveCorrelation,
  type ClientIdentifiers,
} from './correlation.js';
import type { Store } from './store.js';
import type { DumpSink } from './dump.js';

interface ChatOpts {
  store: Store;
  accounts: Accounts;
  client: WorkBuddyClient;
  /** Protocol recorder; disabled unless WKB2API_DUMP_DIR is set. */
  dump?: DumpSink;
}

export function chatCompletionsRoutes(app: FastifyInstance, opts: ChatOpts): void {
  app.post('/chat/completions', async (req, reply) => {
    const body = normalizeOpenAiRequestBody(req.body) as Record<string, unknown>;
    const modelId = typeof body.model === 'string' ? body.model : '';
    const streaming = body.stream === true;
    const info: { model: string; stream: boolean; correlation?: ClientIdentifiers } = {
      model: modelId,
      stream: streaming,
    };
    const record = requestRecorder(opts.store, req, info);
    // Notes collected while accepting the request; they end up in the log row
    // even when the call succeeds, so a silently dropped parameter is visible.
    const notes: string[] = [];
    let note: string | null = null;
    const finish = (outcome: RequestOutcome) => record({ detail: note, ...outcome });
    let correlation: ClientIdentifiers;
    try {
      correlation = resolveCorrelation(req, req.id);
      info.correlation = correlation;
      applyCorrelation(reply, correlation);
    } catch (error) {
      finish({
        status: 400,
        error: error instanceof AppError ? error.code : 'invalid_correlation_id',
        detail: error instanceof Error ? error.message : undefined,
      });
      throw error;
    }

    // Tolerate parameters this gateway does not model. A client that ships a
    // newer OpenAI field, or a provider-specific extra, must not lose a whole
    // agent turn to a 400: the schema strips it and we record the fact.
    const ignored = ignoredRequestFields(body);
    if (ignored.length) {
      notes.push(`ignored unsupported parameters: ${ignored.join(', ')}`);
      req.log.warn({ ignored }, 'ignored unsupported chat parameters');
    }
    if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) {
      notes.push('both max_tokens and max_completion_tokens were sent; max_tokens wins');
    }
    note = notes.length ? notes.join('; ') : null;

    const fail = (error: ReturnType<typeof openAiError>, accountId?: string) => {
      const message: string = error.body.error.message;
      finish({
        status: error.statusCode,
        accountId,
        error: error.body.error.code,
        detail: note ? `${note}; ${message}` : message,
      });
      return reply.code(error.statusCode).send(error.body);
    };
    const parsed = chatRequestSchema.safeParse(body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const path = first?.path.join('.') ?? '';
      return fail(
        openAiError(
          400,
          'invalid_request',
          first ? `${path ? `${path}: ` : ''}${first.message}` : 'Invalid request body.',
          path || null,
        ),
      );
    }
    const request = parsed.data;
    const model = opts.store.model(request.model);
    if (!model || !model.enabled) {
      return fail(openAiError(404, 'model_not_found', `Model '${request.model}' not found.`));
    }

    const context_window = resolvedContextWindow(model, request.context_window);
    const needsCredits = modelConsumesCredits(model);
    const upstreamBody = toUpstreamRequest({ ...request, context_window });
    const abort = new AbortController();
    // Node fires 'close' on the request stream once the body is consumed —
    // before the response is sent. Watch the response stream instead: it
    // closes early only when the client actually disconnects.
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) abort.abort();
    });

    // ---- non-stream: upstream stream + local aggregation -----------------
    let credential: IssuedCredential | undefined;
    if (!request.stream) {
      try {
        const opened = await openUpstream(opts.client, opts.accounts, upstreamBody, abort.signal, {
          apiKeyId: req.apiKeyId ?? undefined,
          requestId: correlation.logicalRequestId,
          needsCredits,
        });
        credential = opened.credential;
        const { stream, upstreamRequestId } = opened;
        const aggregator = new CompletionAggregator();
        for await (const chunk of stream) aggregator.push(chunk);
        const built = aggregator.build(request.model);
        const usage = built.usage;
        opts.accounts.reportSuccess(credential, usage?.total_tokens ?? 0, aggregator.credits);
        finish({
          status: 200,
          accountId: credential.accountId,
          inputTokens: usage?.prompt_tokens,
          outputTokens: usage?.completion_tokens,
          cacheHitTokens: usage?.prompt_tokens_details.cached_tokens,
          reasoningTokens: usage?.completion_tokens_details.reasoning_tokens,
          credits: aggregator.credits,
          upstreamRequestId,
        });
        return built;
      } catch (error) {
        reportAccountFailure(opts.accounts, error, request.model, needsCredits);
        return sendUpstreamError(reply, error, finish);
      }
    }

    // ---- stream: convert and forward frame by frame ----------------------
    const meta = { id: localCompletionId(), created: Math.floor(Date.now() / 1000), model: request.model };
    let settled = false;
    let upstreamRequestId: string | undefined;
    const settle = (
      status: number,
      usage?: UpstreamUsage,
      error?: string,
      credits?: number,
      detail?: string,
    ) => {
      if (settled) return;
      settled = true;
      finish({
        status,
        accountId: credential?.accountId,
        inputTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens,
        cacheHitTokens: usage?.cached_tokens,
        reasoningTokens: usage?.reasoning_tokens,
        credits,
        upstreamRequestId,
        error,
        detail,
      });
    };
    // Record the exact frames the client receives, so a client-side framing
    // problem can be told apart from an upstream one.
    const send = (frame: string) => {
      opts.dump?.write('client_sse', { requestId: req.id, text: frame });
      reply.raw.write(frame);
    };
    // Status is committed below; upstream errors after that point become SSE error frames.
    try {
      const opened = await openUpstream(opts.client, opts.accounts, upstreamBody, abort.signal, {
        apiKeyId: req.apiKeyId ?? undefined,
        requestId: correlation.logicalRequestId,
        needsCredits,
      });
      credential = opened.credential;
      upstreamRequestId = opened.upstreamRequestId;
      reply.raw.writeHead(200, {
        ...correlationHeaders(correlation, req.id),
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const includeUsage = request.stream_options?.include_usage === true;
      let pendingUsage: UpstreamUsage | null = null;
      let credits: number | undefined;
      for await (const chunk of opened.stream) {
        // The usage-bearing frame is the finish frame; always forward its
        // finish_reason/delta, but hold the usage block for the optional chunk.
        if (chunk.usage) {
          if (typeof chunk.usage.credit === 'number') credits = chunk.usage.credit;
          if (includeUsage) pendingUsage = chunk.usage;
          const converted = toOpenAiChunk({ ...chunk, usage: null }, meta);
          if (converted) send(`data: ${JSON.stringify(converted)}\n\n`);
          continue;
        }
        const converted = toOpenAiChunk(chunk, meta);
        if (converted) send(`data: ${JSON.stringify(converted)}\n\n`);
      }
      if (pendingUsage) {
        opts.accounts.reportSuccess(credential, pendingUsage.total_tokens ?? 0, credits ?? 0);
        settle(200, pendingUsage, undefined, credits);
        reply.raw.write(
          `data: ${JSON.stringify({
            id: meta.id,
            object: 'chat.completion.chunk',
            created: meta.created,
            model: meta.model,
            choices: [],
            usage: toOpenAiUsage(pendingUsage),
          })}\n\n`,
        );
      } else {
        opts.accounts.reportSuccess(credential, 0);
        settle(200, undefined, undefined, credits);
      }
      send('data: [DONE]\n\n');
      reply.raw.end();
    } catch (error) {
      reportAccountFailure(opts.accounts, error, request.model, needsCredits);
      const mapped = mapUpstreamError(error);
      if (!reply.raw.headersSent) {
        settle(mapped.statusCode, undefined, mapped.body.error.code, undefined, mapped.body.error.message);
        return reply.code(mapped.statusCode).send(mapped.body);
      }
      settle(mapped.statusCode, undefined, mapped.body.error.code, undefined, mapped.body.error.message);
      if (!reply.raw.destroyed && !abort.signal.aborted) {
        send(`data: ${JSON.stringify({ error: mapped.body.error })}\n\n`);
        reply.raw.end();
      }
    }
    return reply;
  });
}

function sendUpstreamError(
  reply: FastifyReply,
  error: unknown,
  record: (outcome: RequestOutcome) => void,
): FastifyReply {
  const mapped = mapUpstreamError(error);
  record({
    status: mapped.statusCode,
    error: mapped.body.error.code,
    detail: mapped.body.error.message,
    ...(mapped.upstreamRequestId ? { upstreamRequestId: mapped.upstreamRequestId } : {}),
  });
  applyRetryAfter(reply, mapped);
  return reply.code(mapped.statusCode).send(upstreamErrorPayload(mapped));
}

/**
 * Retry contract shared by every endpoint: a retryable failure carries
 * `Retry-After` **and** `error.retryable` / `error.retry_after`, because
 * clients disagree on which one they read (see docs/retry-policy.md).
 */
export function applyRetryAfter(reply: FastifyReply, mapped: MappedError): void {
  if (mapped.retryAfter !== undefined) reply.header('Retry-After', String(mapped.retryAfter));
}

export function upstreamErrorPayload(mapped: MappedError): unknown {
  if (mapped.retryAfter === undefined) return mapped.body;
  return {
    error: { ...mapped.body.error, retryable: true, retry_after: mapped.retryAfter },
  };
}

/** Upper bound on how many accounts one client call may burn through. */
const ACCOUNT_FAILOVER_LIMIT = 3;

/**
 * Account-scoped failures mean *this* account cannot serve the call, not that
 * the client did anything wrong: quota exhaustion, rejected credentials or a
 * blocked account. The pool retires the account and the same client call is
 * retried on the next one, so a single dead account no longer kills a task.
 */
function isAccountScopedFailure(error: unknown): error is UpstreamHttpError & { accountId: string } {
  if (!(error instanceof UpstreamHttpError) || !error.accountId) return false;
  if (isQuotaFailure(error.status, error.code, error.upstreamMessage)) return true;
  if (isAccountBlocked(error.code, error.upstreamMessage)) return true;
  return error.status === 401 || error.status === 402 || error.status === 403;
}

export async function openUpstream(
  client: WorkBuddyClient,
  accounts: Accounts,
  body: Parameters<WorkBuddyClient['streamChatCompletion']>[0],
  signal: AbortSignal,
  options: Parameters<WorkBuddyClient['streamChatCompletion']>[2],
): Promise<UpstreamStream> {
  let accountError: unknown;
  // Accounts already burned by this client call, so the retry moves on instead
  // of picking the same one again (a quota reply no longer quarantines the
  // whole account, so nothing else would stop it).
  const tried = new Set<string>();
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.streamChatCompletion(body, signal, { ...options, excludeAccounts: tried });
    } catch (error) {
      if (signal.aborted) throw error;
      // The pool went dry while looking for a replacement: report why the
      // first account failed instead of a bare "no account available".
      if (error instanceof NoAvailableAccountsError && accountError) throw accountError;
      if (attempt >= ACCOUNT_FAILOVER_LIMIT || !isAccountScopedFailure(error)) throw error;
      accountError = error;
      tried.add(error.accountId);
      // The failed account is excluded from the retry, so it is used once per
      // client call no matter which cooldown policy applies to it.
      if (isAccountBlocked(error.code, error.upstreamMessage)) {
        accounts.reportBlocked(error.accountId, error.upstreamMessage);
      } else if (isQuotaFailure(error.status, error.code, error.upstreamMessage)) {
        accounts.reportQuotaExhausted(error.accountId, 'Upstream quota or balance is exhausted.', {
          model: body.model,
          accountWide: !options?.needsCredits,
        });
      } else {
        accounts.reportFailureById(error.accountId, 'Upstream rejected this account; switching.');
      }
    }
  }
}

/**
 * Account-scoped upstream failures must leave the rotation, otherwise a pinned
 * client would keep retrying the same dead account forever. Quota exhaustion
 * parks the account for a probe window (an operator top-up brings it back
 * automatically); a risk-control block disables it outright because waiting
 * cannot fix it.
 */
export function reportAccountFailure(
  accounts: Accounts,
  error: unknown,
  model?: string,
  needsCredits = true,
): void {
  if (!(error instanceof UpstreamHttpError) || !error.accountId) return;
  if (isAccountBlocked(error.code, error.upstreamMessage)) {
    accounts.reportBlocked(error.accountId, error.upstreamMessage);
    return;
  }
  if (isQuotaFailure(error.status, error.code, error.upstreamMessage)) {
    accounts.reportQuotaExhausted(error.accountId, 'Upstream quota or balance is exhausted.', {
      model,
      accountWide: !needsCredits,
    });
  }
}

export type MappedError = ReturnType<typeof openAiError> & {
  retryAfter?: number;
  upstreamRequestId?: string;
};

/**
 * Transient upstream trouble is reported as a retryable 429 with `Retry-After`
 * so the client retries instead of failing the task; only a request the
 * gateway itself translated badly stays a 4xx. See docs/retry-policy.md.
 */
const TRANSIENT_RETRY_SECONDS = 1;

export function mapUpstreamError(error: unknown): MappedError {
  if (error instanceof NoAvailableAccountsError) {
    return {
      ...(error.code === 'insufficient_quota'
        ? openAiError(429, 'insufficient_quota', error.message)
        : openAiError(503, 'upstream_error', error.message)),
      retryAfter: error.availability.retryAfterSeconds,
    };
  }
  if (error instanceof CredentialError) {
    return openAiError(503, 'upstream_authentication_error', error.message);
  }
  if (error instanceof UpstreamHttpError) {
    const mapped = mapHttpStatus(error);
    const retryAfter =
      error.retryAfterSeconds ?? (mapped.statusCode === 429 ? TRANSIENT_RETRY_SECONDS : undefined);
    return {
      ...mapped,
      ...(retryAfter !== undefined ? { retryAfter } : {}),
      ...(error.requestId ? { upstreamRequestId: error.requestId } : {}),
    };
  }
  if (error instanceof UpstreamProtocolError) {
    return {
      ...openAiError(429, 'upstream_protocol_error', error.message),
      retryAfter: TRANSIENT_RETRY_SECONDS,
    };
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return openAiError(499, 'invalid_request', 'Request aborted by client.');
  }
  if (error instanceof Error && /timeout/i.test(error.message)) {
    return {
      ...openAiError(429, 'upstream_timeout', 'Upstream request timed out.'),
      retryAfter: TRANSIENT_RETRY_SECONDS,
    };
  }
  // Network-level failures (DNS, connection reset, TLS) surface as TypeError or
  // an Error carrying a Node error code; they are retryable too.
  if (isNetworkFailure(error)) {
    return {
      ...openAiError(429, 'upstream_error', 'The upstream connection failed.'),
      retryAfter: TRANSIENT_RETRY_SECONDS,
    };
  }
  return openAiError(500, 'internal_error', 'Request could not be processed.');
}

function mapHttpStatus(error: UpstreamHttpError): ReturnType<typeof openAiError> {
  if (isAccountBlocked(error.code, error.upstreamMessage)) {
    // The account is disabled, so a retry lands on another one.
    return openAiError(
      429,
      'upstream_error',
      'Upstream restricted this account; it was disabled and the request can be retried.',
    );
  }
  if (isQuotaFailure(error.status, error.code, error.upstreamMessage)) {
    return openAiError(429, 'insufficient_quota', 'Upstream quota or balance is exhausted.');
  }
  if (isContextOverflow(error.status, error.code, error.upstreamMessage)) {
    // Clients (Codex, ZCode) only compact and retry when they recognise the
    // failure, so keep both the canonical code and a matching message.
    return openAiError(
      400,
      'context_length_exceeded',
      `The model context window was exceeded: ${
        redactError(error.upstreamMessage ?? '') || 'the prompt is too long'
      }`,
    );
  }
  switch (error.status) {
    case 401:
    case 403:
      // The account is out of rotation after this failure; a retry (usually on
      // another account) can succeed, so report it as retryable.
      return openAiError(
        429,
        'upstream_authentication_error',
        'Upstream WorkBuddy credentials were rejected. Sign in again from the admin panel.',
      );
    case 429:
      return openAiError(429, 'rate_limit_exceeded', 'Upstream rate limit exceeded.');
    case 404:
      return openAiError(502, 'upstream_error', 'Upstream endpoint not found (protocol drift?).');
    default:
      if (error.status >= 500) {
        return openAiError(429, 'upstream_error', `Upstream server error (HTTP ${error.status}).`);
      }
      // A 4xx from upstream means the gateway translated the request badly or
      // the request content was rejected; surface the upstream message.
      return openAiError(
        400,
        'invalid_request',
        `Upstream rejected the request: ${error.upstreamMessage || `HTTP ${error.status}`}`,
      );
  }
}

const NETWORK_ERROR_CODES =
  /^(?:EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EPIPE|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/;

function isNetworkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof TypeError) return true;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && NETWORK_ERROR_CODES.test(code);
}

export type { StoredModel };
