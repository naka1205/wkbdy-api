import { z } from 'zod';
import {
  DEFAULT_SYSTEM_PROMPT,
  mapThinkingToReasoningEffort,
  thinkingSchema,
  type UpstreamChatRequest,
} from '../request.js';

/**
 * Downstream (Responses) request. Only the envelope is validated here: input
 * items are mapped by hand so that an item type this gateway does not model
 * (Codex's `additional_tools`, `reasoning`, …) is ignored with a note instead
 * of failing the whole agent turn.
 */
export const responsesRequestSchema = z.object({
  model: z.string().min(1),
  input: z.union([z.string(), z.array(z.record(z.any())).min(1)]),
  instructions: z.string().optional(),
  stream: z.boolean().default(false),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_output_tokens: z.number().int().positive().optional(),
  tools: z.array(z.record(z.any())).optional(),
  tool_choice: z
    .union([
      z.enum(['none', 'auto', 'required']),
      z.object({ type: z.string(), name: z.string().min(1) }),
      z.object({ type: z.string() }),
    ])
    .optional(),
  parallel_tool_calls: z.boolean().optional(),
  reasoning: z
    .object({
      effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
    })
    .optional(),
  thinking: thinkingSchema.optional(),
  context_window: z.number().int().positive().optional(),
  store: z.boolean().optional(),
});

export type ResponsesRequest = z.infer<typeof responsesRequestSchema>;

/** Fields the route forwards; anything else is reported by the route. */
export const RESPONSES_REQUEST_FIELDS = new Set(Object.keys(responsesRequestSchema.shape));

export class ResponsesInputError extends Error {
  constructor(
    message: string,
    /** Dotted path inside the request body, e.g. `input.2.content`. */
    public readonly path?: string,
  ) {
    super(message);
    this.name = 'ResponsesInputError';
  }
}

export type ResponsesMapping = {
  /** The chat/completions body sent to WorkBuddy. */
  upstream: UpstreamChatRequest;
  /** Tools actually declared upstream (namespaces flattened). */
  tools: unknown[];
  /** Freeform tools; their calls must come back as `custom_tool_call` items. */
  customTools: Set<string>;
  /** What could not be expressed upstream, for the request log. */
  ignored: string[];
};

const isRecord = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** A freeform tool becomes a function tool with one string argument. */
function freeformParameters() {
  return {
    type: 'object',
    properties: { input: { type: 'string', description: 'Raw input for this tool.' } },
    required: ['input'],
    additionalProperties: false,
  };
}

type ToolCollector = {
  tools: unknown[];
  custom: Set<string>;
  ignored: string[];
  seen: Set<string>;
};

/**
 * Flatten one Responses tool (or a namespace of them) into chat/completions
 * function tools. `function` maps directly; `custom` (Codex's freeform tools,
 * e.g. `exec`) is wrapped into a single-string-argument function.
 */
function addTool(tool: unknown, where: string, out: ToolCollector): void {
  if (!isRecord(tool)) {
    out.ignored.push(`${where}:not-an-object`);
    return;
  }
  const type = typeof tool.type === 'string' ? tool.type : 'function';
  if (type === 'namespace') {
    for (const nested of Array.isArray(tool.tools) ? tool.tools : []) addTool(nested, where, out);
    return;
  }
  const name = typeof tool.name === 'string' ? tool.name : '';
  if (!name) {
    out.ignored.push(`${where}:${type}-without-name`);
    return;
  }
  if (out.seen.has(name)) return;
  if (type !== 'function' && type !== 'custom') {
    out.ignored.push(`${where}:${name}(${type})`);
    return;
  }
  out.seen.add(name);
  if (type === 'custom') out.custom.add(name);
  const description = typeof tool.description === 'string' ? tool.description : '';
  const parameters =
    type === 'custom' ? freeformParameters() : (tool.parameters ?? tool.function?.parameters);
  out.tools.push({
    type: 'function',
    function: {
      name,
      description,
      parameters:
        isRecord(parameters) && Object.keys(parameters).length
          ? parameters
          : { type: 'object', properties: {} },
    },
  });
}

function messageText(content: unknown, path: string, ignored: string[]): string {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  if (!Array.isArray(content)) {
    ignored.push(`${path}:unexpected-content`);
    return '';
  }
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part);
      continue;
    }
    if (!isRecord(part)) continue;
    const type = typeof part.type === 'string' ? part.type : '';
    if (type === 'input_text' || type === 'output_text' || type === 'text') {
      if (typeof part.text === 'string') parts.push(part.text);
      continue;
    }
    // Images and other media have no text-only equivalent upstream.
    ignored.push(`${path}:${type}`);
  }
  return parts.join('\n');
}

/**
 * Map a Responses request onto the WorkBuddy chat/completions body, collecting
 * the tools and anything that had to be dropped along the way.
 */
export function mapResponsesRequest(
  request: ResponsesRequest,
  options: { contextWindow?: number } = {},
): ResponsesMapping {
  const messages: UpstreamChatRequest['messages'] = [];
  const collector: ToolCollector = { tools: [], custom: new Set(), ignored: [], seen: new Set() };
  for (const tool of request.tools ?? []) addTool(tool, 'tools', collector);
  // The upstream requires messages[0] to be a system prompt.
  messages.push({ role: 'system', content: request.instructions ?? DEFAULT_SYSTEM_PROMPT });

  const pushMessage = (role: string, content: unknown, path: string) => {
    messages.push({
      role: role === 'developer' ? 'system' : role,
      content: messageText(content, path, collector.ignored),
    });
  };

  if (typeof request.input === 'string') {
    messages.push({ role: 'user', content: request.input });
  } else {
    request.input.forEach((raw, index) => {
      const path = `input.${index}`;
      const item = isRecord(raw) ? raw : {};
      const type = typeof item.type === 'string' ? item.type : 'message';
      switch (type) {
        case 'message': {
          const role = typeof item.role === 'string' ? item.role : '';
          if (!['user', 'assistant', 'system', 'developer'].includes(role)) {
            throw new ResponsesInputError(`Unsupported message role '${role}'.`, `${path}.role`);
          }
          pushMessage(role, item.content, `${path}.content`);
          return;
        }
        case 'function_call':
        case 'custom_tool_call': {
          if (typeof item.call_id !== 'string' || !item.call_id) {
            throw new ResponsesInputError('Tool call is missing call_id.', `${path}.call_id`);
          }
          const name = typeof item.name === 'string' ? item.name : '';
          if (!name) throw new ResponsesInputError('Tool call is missing name.', `${path}.name`);
          if (type === 'custom_tool_call') collector.custom.add(name);
          const args =
            type === 'custom_tool_call'
              ? typeof item.input === 'string'
                ? item.input
                : JSON.stringify(item.input ?? '')
              : typeof item.arguments === 'string'
                ? item.arguments
                : JSON.stringify(item.arguments ?? {});
          messages.push({
            role: 'assistant',
            content: '',
            tool_calls: [{ id: item.call_id, type: 'function', function: { name, arguments: args } }],
          } as UpstreamChatRequest['messages'][number]);
          return;
        }
        case 'function_call_output':
        case 'custom_tool_call_output': {
          if (typeof item.call_id !== 'string' || !item.call_id) {
            throw new ResponsesInputError('Tool output is missing call_id.', `${path}.call_id`);
          }
          const output =
            typeof item.output === 'string'
              ? item.output
              : Array.isArray(item.output)
                ? item.output
                    .map((part: unknown) =>
                      isRecord(part) && typeof part.text === 'string' ? part.text : '',
                    )
                    .join('\n')
                : typeof item.output === 'string'
                  ? item.output
                  : JSON.stringify(item.output ?? '');
          messages.push({
            role: 'tool',
            content: output,
            tool_call_id: item.call_id,
          } as UpstreamChatRequest['messages'][number]);
          return;
        }
        case 'additional_tools': {
          // Codex declares its tool set here rather than in `tools`.
          for (const tool of Array.isArray(item.tools) ? item.tools : []) {
            addTool(tool, `${path}.tools`, collector);
          }
          return;
        }
        case 'reasoning': {
          // Encrypted reasoning has no chat/completions equivalent; it only
          // affects quality, never correctness.
          collector.ignored.push(`${path}:reasoning`);
          return;
        }
        default: {
          collector.ignored.push(`${path}:${type || 'unknown-item'}`);
        }
      }
    });
  }

  const upstream: UpstreamChatRequest = {
    model: request.model,
    messages,
    stream: true,
    ...(options.contextWindow !== undefined ? { context_window: options.contextWindow } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.top_p !== undefined ? { top_p: request.top_p } : {}),
    ...(request.max_output_tokens !== undefined ? { max_tokens: request.max_output_tokens } : {}),
    ...(collector.tools.length ? { tools: collector.tools } : {}),
    ...(request.tool_choice !== undefined
      ? {
          // WorkBuddy's Go request schema accepts tool_choice only as a string.
          tool_choice:
            typeof request.tool_choice === 'string'
              ? request.tool_choice
              : 'name' in request.tool_choice && typeof request.tool_choice.name === 'string'
                ? request.tool_choice.name
                : 'auto',
        }
      : {}),
    ...(request.parallel_tool_calls !== undefined
      ? { parallel_tool_calls: request.parallel_tool_calls }
      : {}),
    ...(request.thinking !== undefined
      ? { reasoning_effort: mapThinkingToReasoningEffort(request.thinking, request.reasoning?.effort) }
      : request.reasoning !== undefined
        ? { reasoning_effort: request.reasoning.effort }
        : {}),
  };

  return { upstream, tools: collector.tools, customTools: collector.custom, ignored: collector.ignored };
}
