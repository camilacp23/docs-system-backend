/**
 * HTTP layer of the dependency map: reads the request, calls the service and writes the body. No rules here.
 * Authorization (x-roles) already ran in the middleware generated from the contract. The ETag is the weak hash of the
 * body that Express adds to every GET, and `If-None-Match` answers 304 (D-72); the order of the body is
 * deterministic, so the same data gives the same ETag.
 *
 * @module modules/dependencies/controller
 */
import type { Request, Response } from 'express';
import { nodeTypeOfSegment, type NodeType } from './graph.js';
import type { DependenciesService } from './service.js';

/** `types` as the validator leaves it: an array, or the comma-separated text. */
function typesOf(value: unknown): NodeType[] | undefined {
  if (value === undefined) return undefined;
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return items.map((item) => String(item).trim().toUpperCase() as NodeType);
}

/**
 * Creates the handlers of the /dependencies operations.
 *
 * @param service - Dependencies service.
 */
export function createDependenciesController(service: DependenciesService) {
  return {
    /** GET /dependencies/graph */
    graph: async (req: Request, res: Response): Promise<void> => {
      const environment = typeof req.query.environment === 'string' ? req.query.environment : undefined;
      res.json({
        data: await service.graph({
          applicationId: Number(req.query.applicationId),
          types: typesOf(req.query.types),
          environment,
        }),
      });
    },
    /** GET /dependencies/{type}/{id} */
    neighborhood: async (req: Request, res: Response): Promise<void> => {
      const type = nodeTypeOfSegment(String(req.params.type));
      if (type === undefined) throw new Error(`unexpected dependency type "${String(req.params.type)}"`);
      const depth = req.query.depth === undefined ? 1 : Number(req.query.depth);
      res.json({ data: await service.neighborhood({ type, id: Number(req.params.id), depth }) });
    },
  };
}
