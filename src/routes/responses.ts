import type { FastifyInstance } from 'fastify';
import {
  ResponsesInputError,
  mapResponsesRequest,
  RESPONSES_REQUEST_FIELDS,
  responsesRequestSchema,
  type ResponsesMapping,
} from '../openai/responses-request-mapper.js';
import { normalizeOpenAiRequestBody } from '../request.js';
import { ResponsesBuilder, freeformInput } from '../openai/responses-builder.js';
import { openAiError } from '../openai/errors.js';
import { AppError } from '../errors.js';
import {
  applyRetryAfter,
  mapUpstreamError,
  openUpstream,
  reportAccountFailure,
  upstreamErrorPayload,
} from '../proxy.js';
import type { IssuedCredential, UpstreamChunk, WorkBuddyClient } from '../upstream.js';
import { modelConsumesCredits, resolvedContextWindow } from '../models.js';
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

function responseOptions(
  request: ReturnType<typeof responsesRequestSchema.parse>,
  mapping?: ResponsesMapping,
) {
  return {
    model: request.model,
    instructions: request.instructions,
    maxOutputTokens: request.max_output_tokens,
    parallelToolCalls: request.parallel_tool_calls,
    temperature: request.temperature,
    topP: request.top_p,
    toolChoice: request.tool_choice,
    tools: mapping?.tools ?? request.tools,
    customTools: mapping?.customTools,
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
    const ignoredFields = Object.keys(body).filter((key) => !RESPONSES_REQUEST_FIELDS.has(key));
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
      const path = issue?.path.join('.') ?? '';
      return fail(
        openAiError(
          400,
          'invalid_request',
          issue ? `${path ? `${path}: ` : ''}${issue.message}` : 'Invalid Responses request.',
          path || null,
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
    let mapped: ResponsesMapping;
    try {
      mapped = mapResponsesRequest(request, { contextWindow: context_window });
    } catch (error) {
      if (error instanceof ResponsesInputError) {
        return fail(
          openAiError(
            400,
            'invalid_request',
            `${error.path ? `${error.path}: ` : ''}${error.message}`,
            error.path ?? null,
          ),
        );
      }
      return fail(openAiError(400, 'invalid_request', 'Invalid Responses request.'));
    }
    if (mapped.ignored.length) {
      notes.push(`ignored input items: ${mapped.ignored.slice(0, 10).join(', ')}`);
      note = notes.join('; ');
      req.log.warn({ ignored: mapped.ignored }, 'ignored unsupported responses items');
    }
    const upstream = mapped.upstream;

    const abort = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableEnded) abort.abort();
    };
    reply.raw.on('close', onClose);

    let credential: IssuedCredential | undefined;
    try {
      const opened = await openUpstream(opts.client, opts.accounts, upstream, abort.signal, {
        apiKeyId: req.apiKeyId ?? undefined,
        requireDone: true,
        requestId: correlation.logicalRequestId,
        needsCredits: modelConsumesCredits(model),
      });
      credential = opened.credential;
      const upstreamRequestId = opened.upstreamRequestId;
      const builder = new ResponsesBuilder();

      if (!request.stream) {
        for await (const chunk of opened.stream) builder.push(chunk);
        const response = builder.build(responseOptions(request, mapped));
        // Count the call against the account even though Responses is buffered
        // here; otherwise Codex traffic never shows up in the account stats.
        opts.accounts.reportSuccess(credential, builder.usage?.total_tokens ?? 0, builder.credits);
        finish({
          status: 200,
          accountId: credential.accountId,
          inputTokens: builder.usage?.input_tokens,
          outputTokens: builder.usage?.output_tokens,
          cacheHitTokens: builder.usage?.input_tokens_details.cached_tokens,
          reasoningTokens: builder.usage?.output_tokens_details.reasoning_tokens,
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
      const toolIds = new Map<
        number,
        {
          itemId: string;
          callId: string;
          name: string;
          arguments: string;
          /** The item is announced once its name is known, which decides the type. */
          added: boolean;
          custom: boolean;
        }
      >();

      const emitChunk = (chunk: UpstreamChunk) => {
        builder.push(chunk);
        if (chunk.delta.content) {
          if (!textStarted) {
            textStarted = true;
            messageId = builder.textItemId;
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
              itemId: builder.toolItemId(index),
              callId: call.id ?? `call_${index}`,
              name: '',
              arguments: '',
              added: false,
              custom: false,
            };
            toolIds.set(index, state);
          }
          if (call.id) state.callId = call.id;
          if (call.function?.name) state.name += call.function.name;
          if (!state.added && state.name) {
            // Announce only in_progress items; the final item arrives in
            // output_item.done, so the type only has to be close enough here.
            state.added = true;
            state.custom = mapped.customTools.has(state.name);
            writeEvent('response.output_item.added', {
              output_index: outputIndex,
              item: state.custom
                ? {
                    id: state.itemId,
                    type: 'custom_tool_call',
                    status: 'in_progress',
                    call_id: state.callId,
                    name: state.name,
                    input: '',
                  }
                : {
                    id: state.itemId,
                    type: 'function_call',
                    status: 'in_progress',
                    call_id: state.callId,
                    name: state.name,
                    arguments: '',
                  },
            });
          }
          if (call.function?.arguments) {
            state.arguments += call.function.arguments;
            // Freeform input cannot be unwrapped incrementally, so only the
            // final .done event carries it.
            if (!state.custom) {
              writeEvent('response.function_call_arguments.delta', {
                item_id: state.itemId,
                output_index: outputIndex,
                delta: call.function.arguments,
              });
            }
          }
        }
      };

      emitChunk(first.value);
      for await (const chunk of opened.stream) emitChunk(chunk);
      const response = builder.build(responseOptions(request, mapped));

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
        const item = response.output.find((entry) => 'call_id' in entry && entry.call_id === state.callId);
        if (state.custom) {
          writeEvent('response.custom_tool_call_input.done', {
            item_id: state.itemId,
            output_index: outputIndex,
            input: freeformInput(state.arguments),
          });
        } else {
          writeEvent('response.function_call_arguments.done', {
            item_id: state.itemId,
            output_index: outputIndex,
            arguments: state.arguments,
          });
        }
        if (item) writeEvent('response.output_item.done', { output_index: outputIndex, item });
      }
      writeEvent('response.completed', { response });
      opts.accounts.reportSuccess(credential, builder.usage?.total_tokens ?? 0, builder.credits);
      finish({
        status: 200,
        accountId: credential.accountId,
        inputTokens: builder.usage?.input_tokens,
        outputTokens: builder.usage?.output_tokens,
        cacheHitTokens: builder.usage?.input_tokens_details.cached_tokens,
        reasoningTokens: builder.usage?.output_tokens_details.reasoning_tokens,
        credits: builder.credits,
        upstreamRequestId,
      });
      reply.raw.end();
    } catch (error) {
      reportAccountFailure(opts.accounts, error, request.model, modelConsumesCredits(model));
      const mapped = mapUpstreamError(error);
      finish({
        status: abort.signal.aborted ? 499 : mapped.statusCode,
        error: mapped.body.error.code,
        detail: mapped.body.error.message,
      });
      if (!reply.raw.headersSent) {
        applyRetryAfter(reply, mapped);
        return reply.code(mapped.statusCode).send(upstreamErrorPayload(mapped));
      }
      if (!reply.raw.destroyed && !abort.signal.aborted) {
        reply.raw.write(
          `event: error\ndata: ${JSON.stringify({ type: 'error', error: upstreamErrorPayload(mapped) })}\n\n`,
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
