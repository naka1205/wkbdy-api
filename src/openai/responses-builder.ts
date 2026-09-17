import type { UpstreamChunk } from '../upstream.js';

export type ResponsesUsage = {
  input_tokens: number;
  input_tokens_details: { cached_tokens: number };
  output_tokens: number;
  output_tokens_details: { reasoning_tokens: number };
  total_tokens: number;
};

type TextItem = {
  id: string;
  type: 'message';
  status: 'completed';
  role: 'assistant';
  content: Array<{ type: 'output_text'; text: string; annotations: []; logprobs: [] }>;
};

type FunctionItem = {
  id: string;
  type: 'function_call';
  status: 'completed';
  call_id: string;
  name: string;
  arguments: string;
};

export type ResponseOutputItem = TextItem | FunctionItem;

export type OpenAiResponse = {
  id: string;
  object: 'response';
  created_at: number;
  status: 'completed';
  error: null;
  incomplete_details: null;
  instructions: string | null;
  max_output_tokens: number | null;
  model: string;
  output: ResponseOutputItem[];
  parallel_tool_calls: boolean;
  previous_response_id: null;
  reasoning: { effort: null; summary: null };
  store: boolean;
  temperature: number;
  text: { format: { type: 'text' } };
  tool_choice: string | Record<string, unknown>;
  tools: unknown[];
  top_p: number;
  truncation: 'disabled';
  usage: ResponsesUsage | null;
  user: null;
  metadata: Record<string, never>;
};

type ToolState = { id: string; callId: string; name: string; arguments: string };

export class ResponsesBuilder {
  readonly responseId = localResponseId();
  readonly createdAt = Math.floor(Date.now() / 1000);
  private text = '';
  private sawFrame = false;
  private finishReason: string | null = null;
  private usage: ResponsesUsage | null = null;
  /** WorkBuddy credits charged upstream; internal, never sent to clients. */
  credits = 0;
  private readonly tools = new Map<number, ToolState>();

  push(chunk: UpstreamChunk): void {
    this.sawFrame = true;
    if (chunk.delta.content) this.text += chunk.delta.content;
    for (const call of chunk.delta.tool_calls ?? []) {
      const index = typeof call.index === 'number' ? call.index : 0;
      const current = this.tools.get(index) ?? {
        id: localItemId('fc'),
        callId: '',
        name: '',
        arguments: '',
      };
      if (call.id) current.callId = call.id;
      if (call.function?.name) current.name += call.function.name;
      if (call.function?.arguments) current.arguments += call.function.arguments;
      this.tools.set(index, current);
    }
    if (chunk.finish_reason) this.finishReason = chunk.finish_reason;
    if (chunk.usage) {
      if (typeof chunk.usage.credit === 'number') this.credits = chunk.usage.credit;
      const input = chunk.usage.prompt_tokens ?? 0;
      const output = chunk.usage.completion_tokens ?? 0;
      this.usage = {
        input_tokens: input,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: output,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: chunk.usage.total_tokens ?? input + output,
      };
    }
  }

  build(options: {
    model: string;
    instructions?: string;
    maxOutputTokens?: number;
    parallelToolCalls?: boolean;
    temperature?: number;
    topP?: number;
    toolChoice?: string | Record<string, unknown>;
    tools?: unknown[];
  }): OpenAiResponse {
    if (!this.sawFrame) throw new Error('Upstream stream ended without producing a response.');
    if (!this.finishReason) throw new Error('Upstream response did not include a finish reason.');

    const output: ResponseOutputItem[] = [];
    if (this.text) {
      output.push({
        id: localItemId('msg'),
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: this.text, annotations: [], logprobs: [] }],
      });
    }
    for (const [, tool] of [...this.tools.entries()].sort((a, b) => a[0] - b[0])) {
      if (!tool.callId || !tool.name) throw new Error('Upstream returned an incomplete function call.');
      try {
        JSON.parse(tool.arguments);
      } catch {
        throw new Error('Upstream returned invalid function-call arguments.');
      }
      output.push({
        id: tool.id,
        type: 'function_call',
        status: 'completed',
        call_id: tool.callId,
        name: tool.name,
        arguments: tool.arguments,
      });
    }

    return {
      id: this.responseId,
      object: 'response',
      created_at: this.createdAt,
      status: 'completed',
      error: null,
      incomplete_details: null,
      instructions: options.instructions ?? null,
      max_output_tokens: options.maxOutputTokens ?? null,
      model: options.model,
      output,
      parallel_tool_calls: options.parallelToolCalls ?? true,
      previous_response_id: null,
      reasoning: { effort: null, summary: null },
      store: false,
      temperature: options.temperature ?? 1,
      text: { format: { type: 'text' } },
      tool_choice: options.toolChoice ?? 'auto',
      tools: options.tools ?? [],
      top_p: options.topP ?? 1,
      truncation: 'disabled',
      usage: this.usage,
      user: null,
      metadata: {},
    };
  }
}

export function localResponseId(): string {
  return localItemId('resp');
}

export function localItemId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `${prefix}_${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
