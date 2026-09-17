import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError, redactError } from './errors.js';
import { stripBearer } from './credentials.js';

/**
 * Correlation IDs the client may attach to a call. They are diagnostic only:
 * the gateway never deduplicates or replays a request because of them, and a
 * task ID may cover many model calls.
 */
export type ClientIdentifiers = {
  /** Task the call belongs to; falls back to the ZCODE query ID header. */
  taskId?: string;
  sessionId?: string;
  traceId?: string;
  /** Client attempt identifier; never used as the gateway request ID. */
  clientRequestId?: string;
  /** Groups retries of one model call; defaults to the gateway request ID. */
  logicalRequestId: string;
  clientAttempt?: number;
};

/** Opaque identifiers only: no whitespace, quotes or control characters. */
const opaqueId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);

const identifiersSchema = z
  .object({
    taskId: opaqueId.optional(),
    sessionId: opaqueId.optional(),
    traceId: opaqueId.optional(),
    clientRequestId: opaqueId.optional(),
    logicalRequestId: opaqueId.optional(),
    clientAttempt: z.coerce.number().int().min(1).max(10000).optional(),
  })
  .strict();

function firstHeader(value: string | string[] | undefined): unknown {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === undefined || raw === '' ? undefined : raw;
}

/**
 * Read the optional correlation headers, mirroring the header contract in
 * `docs/retry-policy.md`. Malformed or credential-shaped values are rejected
 * instead of being written to logs or echoed back.
 */
export function resolveCorrelation(request: FastifyRequest, requestId: string): ClientIdentifiers {
  const headers = request.headers;
  const input = {
    taskId: firstHeader(headers['x-task-id']) ?? firstHeader(headers['x-query-id']),
    sessionId: firstHeader(headers['x-session-id']),
    traceId: firstHeader(headers['x-zcode-trace-id']),
    clientRequestId: firstHeader(headers['x-request-id']),
    logicalRequestId: firstHeader(headers['x-logical-request-id']),
    clientAttempt: firstHeader(headers['x-retry-attempt']),
  };
  const parsed = identifiersSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join('.') ?? 'identifier';
    throw new AppError(
      400,
      'invalid_correlation_id',
      `${field} must be an opaque identifier of at most 128 characters (letters, digits, _ . : -).`,
    );
  }
  const values = { ...parsed.data };
  const secret = stripBearer(String(headers.authorization ?? ''));
  for (const [field, value] of Object.entries(values)) {
    if (typeof value !== 'string') continue;
    if (secret && redactError(value, [secret]) !== value) {
      throw new AppError(
        400,
        'invalid_correlation_id',
        `${field} must be an opaque identifier, not a credential.`,
      );
    }
  }
  return { ...values, logicalRequestId: values.logicalRequestId ?? requestId };
}

/**
 * Headers echoed to the client so it can correlate its own retries. Raw
 * (streaming) responses bypass Fastify's header handling, so callers that
 * write their own head must include these explicitly.
 */
export function correlationHeaders(
  identifiers: ClientIdentifiers,
  requestId: string,
): Record<string, string> {
  return {
    'X-Request-Id': requestId,
    'X-Logical-Request-Id': identifiers.logicalRequestId,
    ...(identifiers.taskId ? { 'X-Task-Id': identifiers.taskId } : {}),
  };
}

export function applyCorrelation(reply: FastifyReply, identifiers: ClientIdentifiers): void {
  reply.header('X-Logical-Request-Id', identifiers.logicalRequestId);
  if (identifiers.taskId) reply.header('X-Task-Id', identifiers.taskId);
}

/** IDs as stored on a request log row. */
export type CorrelatedLogFields = {
  taskId: string | null;
  sessionId: string | null;
  traceId: string | null;
  clientRequestId: string | null;
  logicalRequestId: string | null;
  clientAttempt: number | null;
};

export function logFields(identifiers: ClientIdentifiers): CorrelatedLogFields {
  return {
    taskId: identifiers.taskId ?? null,
    sessionId: identifiers.sessionId ?? null,
    traceId: identifiers.traceId ?? null,
    clientRequestId: identifiers.clientRequestId ?? null,
    logicalRequestId: identifiers.logicalRequestId,
    clientAttempt: identifiers.clientAttempt ?? null,
  };
}
