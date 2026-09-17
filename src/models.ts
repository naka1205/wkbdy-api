import { z } from 'zod';
import type { ExposedModel } from './catalog.js';

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

const workBuddyMetaSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  is_default: z.boolean(),
  max_input_tokens: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  supports_images: z.boolean().optional(),
  supports_tool_call: z.boolean().optional(),
  supports_reasoning: z.boolean().optional(),
  only_reasoning: z.boolean().optional(),
  reasoning: reasoningSchema.optional(),
  context_window: contextWindowSchema.optional(),
  credits: z.string().optional(),
  temperature: z.number().optional(),
});

/**
 * A catalog entry as stored in SQLite: the upstream capability metadata plus
 * the two fields the panel owns — whether the model is exposed at all, and the
 * context window every account request should use for it.
 */
export const storedModelSchema = z
  .object({
    id: z.string().min(1),
    object: z.literal('model'),
    created: z.number(),
    owned_by: z.string(),
    enabled: z.boolean(),
    context_window: z.number().int().positive().optional(),
    x_workbuddy: workBuddyMetaSchema,
  })
  .strict();

export type StoredModel = z.infer<typeof storedModelSchema>;

export const modelPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    context_window: z.number().int().positive().nullable().optional(),
  })
  .strict();

export function fromExposed(
  exposed: ExposedModel,
  extra: { enabled?: boolean; contextWindow?: number } = {},
): StoredModel {
  return storedModelSchema.parse({
    id: exposed.id,
    object: 'model',
    created: exposed.created,
    owned_by: exposed.owned_by,
    enabled: extra.enabled ?? true,
    ...(extra.contextWindow !== undefined ? { context_window: extra.contextWindow } : {}),
    x_workbuddy: { ...exposed.x_workbuddy },
  });
}

/** Drop gateway-only fields before answering a client request. */
export function toExposed(model: StoredModel): ExposedModel {
  const { enabled: _enabled, context_window: _contextWindow, ...rest } = model;
  return rest as ExposedModel;
}

/**
 * Context window sent upstream when neither the client nor the panel picks one.
 * The widest window WorkBuddy advertises is 1M, so the gateway asks for that
 * unless a client passes its own value.
 */
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;

/**
 * Context-window resolution order: the value the client asked for (passed
 * through as-is, no catalog lookup) → the server-side selection for that model
 * → {@link DEFAULT_CONTEXT_WINDOW}.
 */
export function resolvedContextWindow(model: StoredModel, requested?: number): number | undefined {
  if (requested !== undefined) return requested;
  const selected = model.context_window;
  if (selected !== undefined) return selected;
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Whether the upstream charges credits for this model. WorkBuddy advertises
 * the price as `x0.34 credits`, and `x0.00` models are free, so an account
 * without a balance can still serve them. Unknown metadata counts as paid:
 * guessing "free" would let an empty account break paid requests.
 */
export function modelConsumesCredits(model: StoredModel | undefined): boolean {
  const match = /x\s*(\d*\.?\d+)/i.exec(model?.x_workbuddy.credits ?? '');
  return match ? Number(match[1]) > 0 : true;
}
