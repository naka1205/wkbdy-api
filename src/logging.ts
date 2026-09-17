import type { FastifyRequest } from 'fastify';
import type { Store } from './store.js';
import type { ClientIdentifiers } from './correlation.js';

export type RequestOutcome = {
  status: number;
  accountId?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Prompt tokens the upstream served from its prompt cache. */
  cacheHitTokens?: number;
  /** Reasoning tokens billed inside outputTokens. */
  reasoningTokens?: number;
  /** Credits the upstream charged for this request (WorkBuddy `usage.credit`). */
  credits?: number;
  /** Trace ID the upstream echoed back for this call. */
  upstreamRequestId?: string;
  error?: string;
  /** Human-readable explanation for the panel (validation or upstream message). */
  detail?: string | null;
};

/**
 * One request → one row in `request_logs`. Streamed responses call the
 * returned function once, after the stream settles, so a client disconnect
 * still leaves a record.
 */
export function requestRecorder(
  store: Store,
  request: FastifyRequest,
  info: { model: string; stream: boolean; correlation?: ClientIdentifiers },
): (outcome: RequestOutcome) => void {
  const startedAt = performance.now();
  let recorded = false;
  return (outcome) => {
    if (recorded) return;
    recorded = true;
    // Read at settle time: a route may attach the correlation IDs after the
    // recorder was created but before the outcome is known.
    const correlation = info.correlation;
    const inputTokens = outcome.inputTokens ?? 0;
    const outputTokens = outcome.outputTokens ?? 0;
    store.recordLog({
      requestId: request.id,
      timestamp: new Date().toISOString(),
      apiKeyId: request.apiKeyId ?? null,
      apiKeyName: request.apiKeyName ?? null,
      model: info.model,
      endpoint: request.url,
      accountId: outcome.accountId ?? null,
      stream: info.stream,
      status: outcome.status,
      durationMs: Math.round(performance.now() - startedAt),
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      cacheHitTokens: outcome.cacheHitTokens ?? 0,
      reasoningTokens: outcome.reasoningTokens ?? 0,
      credits: outcome.credits ?? 0,
      taskId: correlation?.taskId ?? null,
      sessionId: correlation?.sessionId ?? null,
      traceId: correlation?.traceId ?? null,
      clientRequestId: correlation?.clientRequestId ?? null,
      logicalRequestId: correlation?.logicalRequestId ?? null,
      clientAttempt: correlation?.clientAttempt ?? null,
      upstreamRequestId: outcome.upstreamRequestId ?? null,
      error: outcome.error ?? null,
      detail: outcome.detail ?? null,
    });
  };
}
