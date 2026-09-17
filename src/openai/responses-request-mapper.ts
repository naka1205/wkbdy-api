import { z } from 'zod';
import {
  DEFAULT_SYSTEM_PROMPT,
  mapThinkingToReasoningEffort,
  thinkingSchema,
  type UpstreamChatRequest,
} from '../request.js';

const inputText = z.object({ type: z.literal('input_text'), text: z.string() }).strict();
const outputText = z.object({ type: z.literal('output_text'), text: z.string() }).strict();
const inputImage = z
  .object({
    type: z.literal('input_image'),
    image_url: z
      .string()
      .url()
      .refine((value) => ['http:', 'https:', 'data:'].includes(new URL(value).protocol)),
    detail: z.enum(['auto', 'low', 'high']).optional(),
  })
  .strict();

const messageItem = z
  .object({
    type: z.literal('message').optional(),
    role: z.enum(['user', 'assistant', 'system', 'developer']),
    content: z.union([
      z.string(),
      z.array(z.discriminatedUnion('type', [inputText, outputText, inputImage])).min(1),
    ]),
  })
  .strict();

const functionCallItem = z
  .object({
    type: z.literal('function_call'),
    call_id: z.string().min(1),
    name: z.string().min(1),
    arguments: z.string(),
  })
  .strict();

const functionOutputItem = z
  .object({
    type: z.literal('function_call_output'),
    call_id: z.string().min(1),
    output: z.union([z.string(), z.array(inputText).min(1)]),
  })
  .strict();

const functionTool = z
  .object({
    type: z.literal('function'),
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.object({ type: z.literal('object') }).passthrough(),
    strict: z.boolean().optional(),
  })
  .strict();

export const responsesRequestSchema = z
  .object({
    model: z.string().min(1),
    input: z.union([
      z.string(),
      z.array(z.discriminatedUnion('type', [messageItem, functionCallItem, functionOutputItem])).min(1),
    ]),
    instructions: z.string().optional(),
    stream: z.boolean().default(false),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_output_tokens: z.number().int().positive().optional(),
    tools: z.array(functionTool).optional(),
    tool_choice: z
      .union([
        z.enum(['none', 'auto', 'required']),
        z.object({ type: z.literal('function'), name: z.string().min(1) }).strict(),
      ])
      .optional(),
    parallel_tool_calls: z.boolean().optional(),
    reasoning: z
      .object({
        effort: z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
      })
      .strict()
      .optional(),
    thinking: thinkingSchema.optional(),
    context_window: z.number().int().positive().optional(),
    store: z.boolean().optional(),
  })
  .strict();

export type ResponsesRequest = z.infer<typeof responsesRequestSchema>;

export class ResponsesInputError extends Error {}

export function toWorkBuddyResponseRequest(request: ResponsesRequest): UpstreamChatRequest {
  const messages: UpstreamChatRequest['messages'] = [
    {
      role: 'system',
      content: request.instructions ?? DEFAULT_SYSTEM_PROMPT,
    },
  ];

  if (typeof request.input === 'string') {
    messages.push({ role: 'user', content: request.input });
  } else {
    const knownCalls = new Set<string>();
    for (const item of request.input) {
      if (item.type === 'function_call') {
        if (knownCalls.has(item.call_id))
          throw new ResponsesInputError('function_call call_id values must be unique.');
        knownCalls.add(item.call_id);
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: item.call_id,
              type: 'function',
              function: { name: item.name, arguments: item.arguments },
            },
          ],
        } as UpstreamChatRequest['messages'][number]);
        continue;
      }

      if (item.type === 'function_call_output') {
        if (!knownCalls.has(item.call_id))
          throw new ResponsesInputError('function_call_output references an unknown call_id.');
        const output =
          typeof item.output === 'string' ? item.output : item.output.map((part) => part.text).join('\n');
        messages.push({
          role: 'tool',
          content: output,
          tool_call_id: item.call_id,
        } as UpstreamChatRequest['messages'][number]);
        continue;
      }

      const role = item.role === 'developer' ? 'system' : item.role;
      const content =
        typeof item.content === 'string'
          ? item.content
          : item.content.map((part) => {
              if (part.type === 'input_image') {
                return { type: 'image_url', image_url: { url: part.image_url, detail: part.detail } };
              }
              return { type: 'text', text: part.text };
            });
      messages.push({ role, content });
    }
  }

  return {
    model: request.model,
    messages,
    stream: true,
    ...(request.context_window !== undefined ? { context_window: request.context_window } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.top_p !== undefined ? { top_p: request.top_p } : {}),
    ...(request.max_output_tokens !== undefined ? { max_tokens: request.max_output_tokens } : {}),
    ...(request.tools
      ? {
          tools: request.tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
              ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
            },
          })),
        }
      : {}),
    ...(request.tool_choice !== undefined
      ? {
          // WorkBuddy's Go request schema accepts tool_choice only as a string.
          tool_choice:
            typeof request.tool_choice === 'string' ? request.tool_choice : request.tool_choice.name,
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
}
