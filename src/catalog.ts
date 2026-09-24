import { z } from 'zod';

const reasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

const reasoningSchema = z.object({
  canDisableThinking: z.boolean().optional(),
  defaultEffort: reasoningEffortSchema.optional(),
  effort: reasoningEffortSchema.optional(),
  summary: z.string().optional(),
  supportedEfforts: z.array(reasoningEffortSchema).optional(),
});

const contextWindowSchema = z.object({
  defaultLength: z.number().int().positive(),
  supportedLengths: z.array(z.number().int().positive()).min(1),
});

const modelSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  descriptionEn: z.string().optional(),
  descriptionZh: z.string().optional(),
  credits: z.string().optional(),
  isDefault: z.boolean().optional(),
  maxInputTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  maxAllowedSize: z.number().optional(),
  supportsImages: z.boolean().optional(),
  supportsToolCall: z.boolean().optional(),
  supportsReasoning: z.boolean().optional(),
  onlyReasoning: z.boolean().optional(),
  reasoning: reasoningSchema.optional(),
  contextWindow: contextWindowSchema.optional(),
  temperature: z.number().optional(),
  vendor: z.string().optional(),
});

const agentSchema = z.object({
  name: z.string(),
  models: z.array(z.string()),
  modelTags: z.array(z.string()).optional(),
});

export const productConfigSchema = z.object({
  data: z.object({
    models: z.array(modelSchema).min(1),
    agents: z.array(agentSchema).min(1),
    endpoint: z.string().optional(),
  }),
});

export type WbModel = z.infer<typeof modelSchema>;
export type ProductConfig = z.infer<typeof productConfigSchema>;
export type ProductAgent = z.infer<typeof agentSchema>;

export class ConfigParseError extends Error {}

/** Parse and validate the WorkBuddy /v3/config payload. */
export function parseProductConfig(raw: unknown): ProductConfig {
  const parsed = productConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigParseError(
      `invalid product config: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const seen = new Set<string>();
  for (const m of parsed.data.data.models) {
    if (seen.has(m.id)) throw new ConfigParseError(`duplicate model id: ${m.id}`);
    seen.add(m.id);
  }
  assertAgentReferences(parsed.data);
  return parsed.data;
}

/**
 * Every agent must point at a model the payload defines. A dangling reference
 * would silently drop the model from the client-visible catalog, so the import
 * fails instead of writing a half-broken catalog.
 */
export function assertAgentReferences(config: ProductConfig): void {
  const known = new Set(config.data.models.map((model) => model.id));
  for (const agent of config.data.agents) {
    const unknown = agent.models.find((id) => !known.has(id));
    if (unknown) throw new ConfigParseError(`agent '${agent.name}' references unknown model '${unknown}'`);
  }
}

export type ExposedModel = {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  /** WorkBuddy-specific metadata, namespaced so standard clients ignore it. */
  x_workbuddy: {
    name?: string;
    description?: string;
    is_default: boolean;
    max_input_tokens?: number;
    max_output_tokens?: number;
    supports_images?: boolean;
    supports_tool_call?: boolean;
    supports_reasoning?: boolean;
    only_reasoning?: boolean;
    reasoning?: WbModel['reasoning'];
    context_window?: WbModel['contextWindow'];
    credits?: string;
    temperature?: number;
  };
};

/** Agent whose model list defines the client-visible catalog. */
export const EXPOSED_AGENT = 'cli';

/** Map one configured model onto the gateway's catalog entry shape. */
export function toExposedModel(m: WbModel): ExposedModel {
  return {
    id: m.id,
    object: 'model',
    created: 0,
    owned_by: 'workbuddy',
    x_workbuddy: {
      name: m.name,
      description: m.descriptionEn ?? m.descriptionZh,
      is_default: m.isDefault ?? false,
      max_input_tokens: m.maxInputTokens,
      max_output_tokens: m.maxOutputTokens,
      supports_images: m.supportsImages,
      supports_tool_call: m.supportsToolCall,
      supports_reasoning: m.supportsReasoning,
      only_reasoning: m.onlyReasoning,
      reasoning: m.reasoning,
      context_window: m.contextWindow,
      credits: m.credits,
      temperature: m.temperature,
    },
  };
}
