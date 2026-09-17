import type { FastifyInstance, FastifyReply } from 'fastify';
import { chatRequestSchema, normalizeOpenAiRequestBody, toUpstreamRequest } from './request.js';
import {
  UpstreamHttpError,
  UpstreamProtocolError,
  type WorkBuddyClient,
  type IssuedCredential,
} from './upstream.js';
import { CompletionAggregator, localCompletionId, toOpenAiChunk } from './openai/response-builder.js';
import { openAiError } from './openai/errors.js';
import { resolvedContextWindow, type StoredModel } from './models.js';
import type { Accounts } from './accounts.js';
import { AppError, CredentialError, NoAvailableAccountsError, isQuotaFailure } from './errors.js';
import { requestRecorder, type RequestOutcome } from './logging.js';
import {
  applyCorrelation,
  correlationHeaders,
  resolveCorrelation,
  type ClientIdentifiers,
} from './correlation.js';
import type { Store } from './store.js';

/** Fields that would silently change semantics if dropped; reject instead. */
const REJECTED_UNSUPPORTED = new Set([
  'logprobs',
  'top_logprobs',
  'response_format',
  'seed',
  'presence_penalty',
  'frequency_penalty',
  'n',
  'store',
  'metadata',
  'logit_bias',
  'functions',
  'function_call',
  'audio',
  'modalities',
  'prediction',
  'web_search_options',
  'service_tier',
  'speed',
]);

interface ChatOpts {
  store: Store;
  accounts: Accounts;
  client: WorkBuddyClient;
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
    let correlation: ClientIdentifiers;
    try {
      correlation = resolveCorrelation(req, req.id);
      info.correlation = correlation;
      applyCorrelation(reply, correlation);
    } catch (error) {
      record({ status: 400, error: error instanceof AppError ? error.code : 'invalid_correlation_id' });
      throw error;
    }
    const fail = (error: ReturnType<typeof openAiError>, accountId?: string) => {
      record({ status: error.statusCode, accountId, error: error.body.error.code });
      return reply.code(error.statusCode).send(error.body);
    };

    for (const key of Object.keys(body)) {
      if (REJECTED_UNSUPPORTED.has(key)) {
        return fail(
          openAiError(
            400,
            'unsupported_parameter',
            `Parameter '${key}' is not supported by this gateway.`,
            key,
          ),
        );
      }
    }
    if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) {
      return fail(
        openAiError(400, 'invalid_request', 'max_tokens and max_completion_tokens are mutually exclusive.'),
      );
    }
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
        const opened = await opts.client.streamChatCompletion(upstreamBody, abort.signal, {
          apiKeyId: req.apiKeyId ?? undefined,
          requestId: correlation.logicalRequestId,
        });
        credential = opened.credential;
        const { stream, upstreamRequestId } = opened;
        const aggregator = new CompletionAggregator();
        for await (const chunk of stream) aggregator.push(chunk);
        const built = aggregator.build(request.model);
        const usage = built.usage;
        opts.accounts.reportSuccess(credential, usage?.total_tokens ?? 0);
        record({
          status: 200,
          accountId: credential.accountId,
          inputTokens: usage?.prompt_tokens,
          outputTokens: usage?.completion_tokens,
          credits: aggregator.credits,
          upstreamRequestId,
        });
        return built;
      } catch (error) {
        reportQuotaFailure(opts.accounts, error);
        return sendUpstreamError(reply, error, record);
      }
    }

    // ---- stream: convert and forward frame by frame ----------------------
    const meta = { id: localCompletionId(), created: Math.floor(Date.now() / 1000), model: request.model };
    let settled = false;
    let upstreamRequestId: string | undefined;
    const settle = (
      status: number,
      usage?: { prompt_tokens?: number; completion_tokens?: number },
      error?: string,
      credits?: number,
    ) => {
      if (settled) return;
      settled = true;
      record({
        status,
        accountId: credential?.accountId,
        inputTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens,
        credits,
        upstreamRequestId,
        error,
      });
    };
    // Status is committed below; upstream errors after that point become SSE error frames.
    try {
      const opened = await opts.client.streamChatCompletion(upstreamBody, abort.signal, {
        apiKeyId: req.apiKeyId ?? undefined,
        requestId: correlation.logicalRequestId,
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
      let pendingUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null =
        null;
      let credits: number | undefined;
      for await (const chunk of opened.stream) {
        // The usage-bearing frame is the finish frame; always forward its
        // finish_reason/delta, but hold the usage block for the optional chunk.
        if (chunk.usage) {
          if (typeof chunk.usage.credit === 'number') credits = chunk.usage.credit;
          if (includeUsage) {
            pendingUsage = {
              prompt_tokens: chunk.usage.prompt_tokens ?? 0,
              completion_tokens: chunk.usage.completion_tokens ?? 0,
              total_tokens: chunk.usage.total_tokens ?? 0,
            };
          }
          const converted = toOpenAiChunk({ ...chunk, usage: null }, meta);
          if (converted) reply.raw.write(`data: ${JSON.stringify(converted)}\n\n`);
          continue;
        }
        const converted = toOpenAiChunk(chunk, meta);
        if (converted) reply.raw.write(`data: ${JSON.stringify(converted)}\n\n`);
      }
      if (pendingUsage) {
        opts.accounts.reportSuccess(credential, pendingUsage.total_tokens);
        settle(200, pendingUsage, undefined, credits);
        reply.raw.write(
          `data: ${JSON.stringify({
            id: meta.id,
            object: 'chat.completion.chunk',
            created: meta.created,
            model: meta.model,
            choices: [],
            usage: pendingUsage,
          })}\n\n`,
        );
      } else {
        opts.accounts.reportSuccess(credential, 0);
        settle(200, undefined, undefined, credits);
      }
      reply.raw.write('data: [DONE]\n\n');
      reply.raw.end();
    } catch (error) {
      reportQuotaFailure(opts.accounts, error);
      const mapped = mapUpstreamError(error);
      if (!reply.raw.headersSent) {
        settle(mapped.statusCode, undefined, mapped.body.error.code);
        return reply.code(mapped.statusCode).send(mapped.body);
      }
      settle(mapped.statusCode, undefined, mapped.body.error.code);
      if (!reply.raw.destroyed && !abort.signal.aborted) {
        reply.raw.write(`data: ${JSON.stringify({ error: mapped.body.error })}\n\n`);
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
    ...(mapped.upstreamRequestId ? { upstreamRequestId: mapped.upstreamRequestId } : {}),
  });
  if (mapped.retryAfter !== undefined) reply.header('Retry-After', String(mapped.retryAfter));
  const body =
    mapped.retryAfter === undefined
      ? mapped.body
      : { error: { ...mapped.body.error, retry_after: mapped.retryAfter } };
  return reply.code(mapped.statusCode).send(body);
}

/**
 * An account that ran out of quota must leave the rotation, otherwise a pinned
 * client would keep retrying the same exhausted account forever.
 */
export function reportQuotaFailure(accounts: Accounts, error: unknown): void {
  if (!(error instanceof UpstreamHttpError)) return;
  if (!isQuotaFailure(error.status, error.code, error.upstreamMessage)) return;
  if (!error.accountId) return;
  accounts.reportFailureById(error.accountId, 'Upstream quota or balance is exhausted.');
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
      ...openAiError(503, 'upstream_error', error.message),
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
  if (isQuotaFailure(error.status, error.code, error.upstreamMessage)) {
    return openAiError(429, 'insufficient_quota', 'Upstream quota or balance is exhausted.');
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
