import type { FastifyInstance } from 'fastify';
import {
  ResponsesInputError,
  responsesRequestSchema,
  toWorkBuddyResponseRequest,
} from '../openai/responses-request-mapper.js';
import { normalizeOpenAiRequestBody } from '../request.js';
import { ResponsesBuilder } from '../openai/responses-builder.js';
import { openAiError } from '../openai/errors.js';
import { AppError } from '../errors.js';
import { mapUpstreamError, reportQuotaFailure } from '../proxy.js';
import type { IssuedCredential, UpstreamChunk, WorkBuddyClient } from '../upstream.js';
import { resolvedContextWindow } from '../models.js';
import type { Accounts } from '../accounts.js';
import { requestRecorder, type RequestOutcome } from '../logging.js';
import {
  applyCorrelation,
  correlationHeaders,
  resolveCorrelation,
  type ClientIdentifiers,
} from '../correlation.js';
import type { Store } from '../store.js';
import type { DumpSink } from '../dump.js';

type ResponsesOptions = {
  store: Store;
  accounts: Accounts;
  client: WorkBuddyClient;
  /** Protocol recorder; disabled unless WKB2API_DUMP_DIR is set. */
  dump?: DumpSink;
};

function responseOptions(request: ReturnType<typeof responsesRequestSchema.parse>) {
  return {
    model: request.model,
    instructions: request.instructions,
    maxOutputTokens: request.max_output_tokens,
    parallelToolCalls: request.parallel_tool_calls,
    temperature: request.temperature,
    topP: request.top_p,
    toolChoice: request.tool_choice,
    tools: request.tools,
  };
}

/** `/v1/responses`: upstream stream, buffered or streamed as Responses events. */
export function responsesRoutes(app: FastifyInstance, opts: ResponsesOptions): void {
  app.post('/responses', async (req, reply) => {
    const body = normalizeOpenAiRequestBody(req.body) as Record<string, unknown>;
    const info: { model: string; stream: boolean; correlation?: ClientIdentifiers } = {
      model: typeof body.model === 'string' ? body.model : '',
      stream: body.stream === true,
    };
    const record = requestRecorder(opts.store, req, info);
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

    // Unknown top-level fields are ignored rather than rejected; see proxy.ts.
    const ignoredFields = Object.keys(body).filter((key) => !(key in responsesRequestSchema.shape));
    if (ignoredFields.length) {
      notes.push(`ignored unsupported parameters: ${ignoredFields.join(', ')}`);
      req.log.warn({ ignored: ignoredFields }, 'ignored unsupported responses parameters');
    }
    note = notes.length ? notes.join('; ') : null;

    const fail = (error: ReturnType<typeof openAiError>) => {
      const message: string = error.body.error.message;
      finish({
        status: error.statusCode,
        error: error.body.error.code,
        detail: note ? `${note}; ${message}` : message,
      });
      return reply.code(error.statusCode).send(error.body);
    };

    const parsed = responsesRequestSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return fail(
        openAiError(
          400,
          'invalid_request',
          issue?.message ?? 'Invalid Responses request.',
          issue?.path.join('.') || null,
        ),
      );
    }

    const request = parsed.data;
    const model = opts.store.model(request.model);
    if (!model?.enabled) {
      return fail(openAiError(404, 'model_not_found', `Model '${request.model}' not found.`));
    }
    if (
      model.x_workbuddy.max_output_tokens &&
      request.max_output_tokens !== undefined &&
      request.max_output_tokens > model.x_workbuddy.max_output_tokens
    ) {
      return fail(
        openAiError(
          400,
          'invalid_request',
          'max_output_tokens exceeds the configured model output limit.',
          'max_output_tokens',
        ),
      );
    }
    if (request.tools?.length && model.x_workbuddy.supports_tool_call === false) {
      return fail(
        openAiError(400, 'invalid_request', 'This model does not support function tools.', 'tools'),
      );
    }

    const context_window = resolvedContextWindow(
      model,
      (request as { context_window?: number }).context_window,
    );
    let upstream;
    try {
      upstream = toWorkBuddyResponseRequest({ ...request, context_window });
    } catch (error) {
      const message = error instanceof ResponsesInputError ? error.message : 'Invalid Responses request.';
      return fail(openAiError(400, 'invalid_request', message));
    }

    const abort = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableEnded) abort.abort();
    };
    reply.raw.on('close', onClose);

    let credential: IssuedCredential | undefined;
    try {
      const opened = await opts.client.streamChatCompletion(upstream, abort.signal, {
        apiKeyId: req.apiKeyId ?? undefined,
        requireDone: true,
        requestId: correlation.logicalRequestId,
      });
      credential = opened.credential;
      const upstreamRequestId = opened.upstreamRequestId;
      const builder = new ResponsesBuilder();

      if (!request.stream) {
        for await (const chunk of opened.stream) builder.push(chunk);
        const response = builder.build(responseOptions(request));
        finish({
          status: 200,
          accountId: credential.accountId,
          credits: builder.credits,
          upstreamRequestId,
        });
        return response;
      }

      const first = await opened.stream.next();
      if (first.done) throw new Error('Upstream returned no response content.');

      reply.hijack();
      reply.raw.writeHead(200, {
        ...correlationHeaders(correlation, req.id),
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      let sequence = 0;
      const writeEvent = (type: string, event: Record<string, unknown>) => {
        const payload = { type, sequence_number: sequence++, ...event };
        const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
        opts.dump?.write('client_sse', { requestId: req.id, text: frame });
        reply.raw.write(frame);
      };
      const created = {
        id: builder.responseId,
        object: 'response',
        created_at: builder.createdAt,
        status: 'in_progress',
        model: request.model,
        output: [],
      };
      writeEvent('response.created', { response: created });
      writeEvent('response.in_progress', { response: created });

      let textStarted = false;
      let messageId = '';
      const toolIds = new Map<number, { itemId: string; callId: string; name: string; arguments: string }>();

      const emitChunk = (chunk: UpstreamChunk) => {
        builder.push(chunk);
        if (chunk.delta.content) {
          if (!textStarted) {
            textStarted = true;
            messageId = `msg_${builder.responseId.slice(5)}`;
            const item = {
              id: messageId,
              type: 'message',
              status: 'in_progress',
              role: 'assistant',
              content: [],
            };
            writeEvent('response.output_item.added', { output_index: 0, item });
            writeEvent('response.content_part.added', {
              item_id: messageId,
              output_index: 0,
              content_index: 0,
              part: { type: 'output_text', text: '', annotations: [], logprobs: [] },
            });
          }
          writeEvent('response.output_text.delta', {
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            delta: chunk.delta.content,
            logprobs: [],
          });
        }
        for (const call of chunk.delta.tool_calls ?? []) {
          const index = typeof call.index === 'number' ? call.index : 0;
          const outputIndex = (textStarted ? 1 : 0) + index;
          let state = toolIds.get(index);
          if (!state) {
            state = {
              itemId: `fc_${builder.responseId.slice(5)}_${index}`,
              callId: call.id ?? `call_${index}`,
              name: call.function?.name ?? '',
              arguments: '',
            };
            toolIds.set(index, state);
            writeEvent('response.output_item.added', {
              output_index: outputIndex,
              item: {
                id: state.itemId,
                type: 'function_call',
                status: 'in_progress',
                call_id: state.callId,
                name: state.name,
                arguments: '',
              },
            });
          } else {
            if (call.id) state.callId = call.id;
            if (call.function?.name) state.name += call.function.name;
          }
          if (call.function?.arguments) {
            state.arguments += call.function.arguments;
            writeEvent('response.function_call_arguments.delta', {
              item_id: state.itemId,
              output_index: outputIndex,
              delta: call.function.arguments,
            });
          }
        }
      };

      emitChunk(first.value);
      for await (const chunk of opened.stream) emitChunk(chunk);
      const response = builder.build(responseOptions(request));

      if (textStarted) {
        const item = response.output.find((entry) => entry.type === 'message');
        const text = item?.type === 'message' ? (item.content[0]?.text ?? '') : '';
        writeEvent('response.output_text.done', {
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          text,
          logprobs: [],
        });
        writeEvent('response.content_part.done', {
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text, annotations: [], logprobs: [] },
        });
        if (item) writeEvent('response.output_item.done', { output_index: 0, item });
      }
      for (const [index, state] of toolIds) {
        const outputIndex = (textStarted ? 1 : 0) + index;
        const item = response.output.find(
          (entry) => entry.type === 'function_call' && entry.call_id === state.callId,
        );
        writeEvent('response.function_call_arguments.done', {
          item_id: state.itemId,
          output_index: outputIndex,
          arguments: state.arguments,
        });
        if (item) writeEvent('response.output_item.done', { output_index: outputIndex, item });
      }
      writeEvent('response.completed', { response });
      finish({
        status: 200,
        accountId: credential.accountId,
        credits: builder.credits,
        upstreamRequestId,
      });
      reply.raw.end();
    } catch (error) {
      reportQuotaFailure(opts.accounts, error);
      const mapped = mapUpstreamError(error);
      finish({
        status: abort.signal.aborted ? 499 : mapped.statusCode,
        error: mapped.body.error.code,
        detail: mapped.body.error.message,
      });
      if (!reply.raw.headersSent) return reply.code(mapped.statusCode).send(mapped.body);
      if (!reply.raw.destroyed && !abort.signal.aborted) {
        reply.raw.write(
          `event: error\ndata: ${JSON.stringify({ type: 'error', error: mapped.body.error })}\n\n`,
        );
        reply.raw.end();
      }
    } finally {
      abort.abort();
      reply.raw.removeListener('close', onClose);
    }
    return reply;
  });
}
