/**
 * An independent, deliberately naive computation of the key screens from the dependency graph, for the tests that
 * compare the onboarding summary with the map. It does not import the module's rules: it counts neighbors with a
 * filter per screen and finds the depth with a queue, so a mistake in the module's own code cannot hide in both.
 */
import type { Graph } from '../../src/modules/dependencies/graph.js';

/** Connections and depth of every screen except App (OnStart), by screen id. */
export function oracleScreens(graph: Graph): Map<number, { connections: number; depth: number | null }> {
  const connecting = (kind: string): boolean => kind === 'ACCESSES' || kind === 'CREATES' || kind === 'NAVIGATES_TO';
  const app = graph.nodes.find((n) => n.type === 'SCREEN' && n.isAppContext)!;

  // BFS with a queue over the outgoing navigations.
  const dist = new Map<string, number>([[app.key, 0]]);
  const queue = [app.key];
  while (queue.length > 0) {
    const key = queue.shift()!;
    for (const edge of graph.edges) {
      if (edge.kind === 'NAVIGATES_TO' && edge.source === key && !dist.has(edge.target)) {
        dist.set(edge.target, dist.get(key)! + 1);
        queue.push(edge.target);
      }
    }
  }

  const result = new Map<number, { connections: number; depth: number | null }>();
  for (const node of graph.nodes) {
    if (node.type !== 'SCREEN' || node.isAppContext) continue;
    const neighbors = new Set<string>();
    for (const edge of graph.edges) {
      if (!connecting(edge.kind)) continue;
      if (edge.source === node.key) neighbors.add(edge.target);
      if (edge.target === node.key) neighbors.add(edge.source);
    }
    result.set(node.id, { connections: neighbors.size, depth: dist.get(node.key) ?? null });
  }
  return result;
}
