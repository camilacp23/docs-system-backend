/**
 * Rules of the dependency map (FR-15, FR-16; D-104). Read only. The service never sees req/res.
 *
 * The graph of an application is read in one snapshot (see the repository), turned into the contract's variants and
 * filtered. The neighborhood of an element starts from the graph of the application that owns it and keeps the nodes
 * reachable within `depth` steps. An application or an element that does not exist (or whose id cannot exist) is 404.
 *
 * @module modules/dependencies/service
 */
import { assertIdInRange } from '../../http/ids.js';
import { E } from '../../security/errors.js';
import { filterGraph, neighborhood, nodeKey, toGraph, type Graph, type NodeType } from './graph.js';
import type { DependenciesRepository } from './repository.js';

/** Filters of `GET /dependencies/graph`, already parsed by the controller. */
export type GraphInput = {
  applicationId: number;
  types?: readonly NodeType[] | undefined;
  environment?: string | undefined;
};

/** Parameters of `GET /dependencies/{type}/{id}`, already parsed by the controller. */
export type NeighborhoodInput = { type: NodeType; id: number; depth: number };

/** The dependencies service. */
export type DependenciesService = {
  graph(input: GraphInput): Promise<Graph>;
  neighborhood(input: NeighborhoodInput): Promise<Graph>;
};

/**
 * Creates the dependencies service.
 *
 * @param repository - Read-only queries of the module.
 */
export function createDependenciesService(repository: DependenciesRepository): DependenciesService {
  return {
    async graph(input) {
      assertIdInRange(input.applicationId, 'application');
      const snapshot = await repository.readApplicationGraph(input.applicationId, input.environment);
      if (snapshot === null) throw E.notFound('application', input.applicationId);
      return filterGraph(toGraph(snapshot.graph), { types: input.types, inEnvironment: snapshot.inEnvironment });
    },

    async neighborhood(input) {
      const element = input.type.toLowerCase();
      assertIdInRange(input.id, element);
      const snapshot = await repository.readElementGraph(input.type, input.id);
      if (snapshot === null) throw E.notFound(element, input.id);
      const key = nodeKey(input.type, input.id);
      const graph = toGraph(snapshot.graph);
      if (!graph.nodes.some((node) => node.key === key)) throw E.notFound(element, input.id);
      return neighborhood(graph, key, input.depth);
    },
  };
}
