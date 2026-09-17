import type { FastifyInstance } from 'fastify';
import { openAiError } from '../openai/errors.js';
import { toExposed } from '../models.js';
import type { Store } from '../store.js';

/** OpenAI-compatible model listing over the stored catalog (enabled entries only). */
export function modelsRoutes(app: FastifyInstance, opts: { store: Store }): void {
  app.get('/models', async () => ({
    object: 'list',
    data: opts.store.exposedModels().map(toExposed),
  }));

  app.get<{ Params: { id: string } }>('/models/:id', async (request, reply) => {
    const model = opts.store.exposedModels().find((entry) => entry.id === request.params.id);
    if (!model) {
      const error = openAiError(404, 'model_not_found', `Model '${request.params.id}' not found.`);
      return reply.code(error.statusCode).send(error.body);
    }
    return toExposed(model);
  });
}
