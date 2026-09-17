import { z } from 'zod';

export const reasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export const thinkingSchema = z.union([
  reasoningEffortSchema,
  z.object({ type: z.literal('adaptive') }),
  z.object({ type: z.literal('disabled') }),
  z.object({ type: z.literal('enabled'), budget_tokens: z.number().int().positive().optional() }),
  z.object({ effort: reasoningEffortSchema }),
]);

export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export type Thinking = z.infer<typeof thinkingSchema>;

export function mapThinkingToReasoningEffort(
  thinking: Thinking,
  fallback: ReasoningEffort = 'high',
): ReasoningEffort {
  if (typeof thinking === 'string') return thinking;
  if ('effort' in thinking) return thinking.effort;
  if (thinking.type === 'disabled') return 'none';
  if (thinking.type === 'adaptive') return fallback;
  if (thinking.budget_tokens === undefined) return fallback;
  return thinking.budget_tokens >= 32768
    ? 'xhigh'
    : thinking.budget_tokens >= 8192
      ? 'high'
      : thinking.budget_tokens >= 2048
        ? 'medium'
        : 'low';
}

/** Some clients serialise absent optional fields as this literal string. */
const UNDEFINED_PLACEHOLDER = '[undefined]';

/**
 * Drop the "[undefined]" placeholders loose clients send (they would otherwise
 * fail validation), without touching real values.
 */
export function normalizeOpenAiRequestBody(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (value === UNDEFINED_PLACEHOLDER) continue;
    out[key] = value;
  }
  if (out.stream_options && typeof out.stream_options === 'object' && !Array.isArray(out.stream_options)) {
    const streamOptions = { ...(out.stream_options as Record<string, unknown>) };
    if (streamOptions.include_usage === UNDEFINED_PLACEHOLDER) delete streamOptions.include_usage;
    out.stream_options = streamOptions;
  }
  return out;
}

/**
 * Parameters a client may send but this gateway does not model. They are
 * ignored (and recorded on the log row) instead of failing the request: a
 * client that ships a newer OpenAI field, or a provider-specific extra, must
 * not lose a whole agent turn to a 400. See docs/client-api.md.
 */
export function ignoredRequestFields(body: Record<string, unknown>): string[] {
  const known = new Set(Object.keys(chatRequestSchema.shape));
  const dropped = Object.keys(body).filter((key) => !known.has(key));
  return [...dropped, ...droppedMessageFields(body.messages)];
}

/**
 * Message-level fields the schema strips. A client that sends, say, a legacy
 * \`function_call\` would otherwise lose it without a trace.
 */
function droppedMessageFields(messages: unknown): string[] {
  if (!Array.isArray(messages)) return [];
  const knownMessageFields = new Set(['role', 'content', 'name', 'tool_calls', 'tool_call_id']);
  const out: string[] = [];
  messages.forEach((message, index) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    for (const key of Object.keys(message)) {
      if (knownMessageFields.has(key)) continue;
      out.push(`messages[${index}].${key}`);
    }
  });
  return out.slice(0, 10);
}

/**
 * Downstream (OpenAI) chat request schema. Fields this gateway understands are
 * declared; anything else is stripped by zod and reported by the route, which
 * keeps unknown client parameters from breaking a call.
 */
export const chatRequestSchema = z.object({
  model: z.string().min(1),
  messages: z
    .array(
      z.object({
        // 'function' is the pre-'tool' role; older transcripts still carry it.
        role: z.enum(['system', 'developer', 'user', 'assistant', 'tool', 'function']),
        // A tool-calling assistant turn legitimately has "content": null, and
        // some clients send a single content part as an object instead of an
        // array. Both are forwarded as-is; the upstream is the final judge.
        content: z.union([z.string(), z.array(z.any()), z.record(z.any()), z.null()]).optional(),
        name: z.string().optional(),
        tool_calls: z.array(z.any()).optional(),
        tool_call_id: z.string().optional(),
      }),
    )
    .min(1, 'messages must contain at least one message'),
  stream: z.boolean().default(false),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  stop: z.union([z.string(), z.array(z.string()).max(4)]).optional(),
  tools: z
    .array(
      z.object({
        type: z.literal('function'),
        function: z.object({
          name: z.string().min(1),
          description: z.string().optional(),
          parameters: z.record(z.any()).optional(),
        }),
      }),
    )
    .optional(),
  tool_choice: z
    .union([
      z.enum(['none', 'auto', 'required']),
      z.object({ type: z.literal('function'), function: z.object({ name: z.string() }) }),
    ])
    .optional(),
  parallel_tool_calls: z.boolean().optional(),
  // Both OpenAI-style strings and common object forms map to WorkBuddy's top-level reasoning_effort.
  reasoning_effort: reasoningEffortSchema.optional(),
  thinking: thinkingSchema.optional(),
  context_window: z.number().int().positive().optional(),
  user: z.string().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).optional(),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;

/**
 * Upstream request builder (OpenAI shape, with the two WorkBuddy quirks from
 * the M2 protocol capture applied):
 *  - upstream rejects stream:false (400 code:11101) → always stream:true
 *  - messages[0] must be system (400 code:11128) → inject a default when absent
 */
export const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';

export type UpstreamChatRequest = {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  stream: true;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  tools?: unknown;
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  reasoning_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  context_window?: number;
};

export function toUpstreamRequest(req: ChatRequest): UpstreamChatRequest {
  const out: UpstreamChatRequest = {
    model: req.model,
    messages: normalizeMessages(req.messages),
    stream: true,
  };
  if (req.temperature !== undefined) out.temperature = req.temperature;
  if (req.top_p !== undefined) out.top_p = req.top_p;
  if (req.max_tokens !== undefined) out.max_tokens = req.max_tokens;
  else if (req.max_completion_tokens !== undefined) out.max_tokens = req.max_completion_tokens;
  if (req.stop !== undefined) out.stop = req.stop;
  if (req.tools !== undefined) out.tools = req.tools;
  if (req.tool_choice !== undefined) out.tool_choice = req.tool_choice;
  if (req.parallel_tool_calls !== undefined) out.parallel_tool_calls = req.parallel_tool_calls;
  if (req.thinking !== undefined)
    out.reasoning_effort = mapThinkingToReasoningEffort(req.thinking, req.reasoning_effort);
  else if (req.reasoning_effort !== undefined) out.reasoning_effort = req.reasoning_effort;
  if (req.context_window !== undefined) out.context_window = req.context_window;
  return out;
}

/**
 * Ensure messages[0] is system. 'developer' is treated as a system prompt by
 * the upstream; if neither a system nor developer message leads, a default
 * system message is injected. Everything else passes through unchanged.
 */
export function normalizeMessages(messages: ChatRequest['messages']): UpstreamChatRequest['messages'] {
  const mapped = messages.map((m) => ({
    role: m.role === 'developer' ? 'system' : m.role,
    content: m.content,
    ...(m.tool_calls !== undefined ? { tool_calls: m.tool_calls } : {}),
    ...(m.tool_call_id !== undefined ? { tool_call_id: m.tool_call_id } : {}),
    ...(m.name !== undefined ? { name: m.name } : {}),
  }));
  if (mapped.length === 0 || mapped[0]!.role !== 'system') {
    return [{ role: 'system', content: DEFAULT_SYSTEM_PROMPT }, ...mapped];
  }
  return mapped;
}
