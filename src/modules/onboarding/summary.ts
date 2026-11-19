/**
 * Pure rules of the onboarding summary (FR-25, D-124). It receives the dependency graph of one application, exactly as
 * the dependency map serves it (`graphOn`), and derives from it the key screens, the global variables and the top
 * components. It has no database and no HTTP, and it defines no graph of its own: the connections, the depth and the
 * uses are read from the same nodes and edges as the map, so the onboarding and the map agree.
 *
 * Every name is compared by code point, like PostgreSQL's `COLLATE "C"` on a UTF-8 database (D-110), never with
 * `localeCompare`. Every list has a total order (the last tie-break is the id), so the body, its ETag and its 304 are
 * stable.
 *
 * @module modules/onboarding/summary
 */
import type { Graph, GraphEdge, GraphNode, ScreenNode } from '../dependencies/graph.js';

/** Items of each list (D-124: limits 10 / 10 / 10). */
export const LIST_LIMIT = 10;

/** `{ id, name }`, the contract's `Ref`. */
export type Ref = { id: number; name: string };

/** A key screen, as the contract serves it. */
export type KeyScreen = {
  screen: Ref;
  documentationStatus: string;
  connections: number;
  depth: number | null;
  miroLink: string | null;
};

/** A global variable before its data type (not a graph field) is added. */
export type GlobalVariableCandidate = { variable: Ref; originScreen: Ref | null; usedByScreens: number };

/** A top component, as the contract serves it. */
export type TopComponent = { component: Ref; screen: Ref; uses: number };

/** The App (OnStart) screen, without its template (not a graph field). */
export type AppContext = { id: number; name: string; documentationStatus: string; miroLink: string | null };

/** What the graph gives. */
export type GraphParts = {
  componentCount: number;
  appContext: AppContext;
  keyScreens: KeyScreen[];
  globalVariables: GlobalVariableCandidate[];
  topComponents: TopComponent[];
};

/**
 * Compares two strings by Unicode code point (not by UTF-16 unit, which orders a character outside the Basic
 * Multilingual Plane before U+E000 to U+FFFF), the order of PostgreSQL's `COLLATE "C"` on UTF-8.
 *
 * @param a - Left text.
 * @param b - Right text.
 * @returns A negative number, zero or a positive number.
 */
export function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const left = a.codePointAt(i)!;
    const right = b.codePointAt(j)!;
    if (left !== right) return left < right ? -1 : 1;
    i += left > 0xffff ? 2 : 1;
    j += right > 0xffff ? 2 : 1;
  }
  if (i < a.length) return 1;
  return j < b.length ? -1 : 0;
}

/** Name by code point, then id. */
const byName = (a: Ref, b: Ref): number => compareCodePoints(a.name, b.name) || a.id - b.id;

/** Depth ascending; a screen that App (OnStart) does not reach (`null`) goes after every reached one. */
function compareDepth(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

/** The edges that make two elements neighbors for `connections` (CONTAINS is not one of them). */
const CONNECTING_KINDS: ReadonlySet<GraphEdge['kind']> = new Set(['ACCESSES', 'CREATES', 'NAVIGATES_TO']);

/**
 * Different screens, variables and collections that are neighbors of each screen through `ACCESSES`, `CREATES` and
 * `NAVIGATES_TO`, in either direction. A neighbor counts once however many edges link it (several `usedIn`, or a
 * navigation in both directions).
 */
function neighborsOfScreens(graph: Graph, screens: ReadonlySet<string>): Map<string, Set<string>> {
  const neighbors = new Map<string, Set<string>>();
  const add = (screen: string, other: string): void => {
    if (!screens.has(screen)) return;
    const set = neighbors.get(screen);
    if (set === undefined) neighbors.set(screen, new Set([other]));
    else set.add(other);
  };
  for (const edge of graph.edges) {
    if (!CONNECTING_KINDS.has(edge.kind)) continue;
    add(edge.source, edge.target);
    add(edge.target, edge.source);
  }
  return neighbors;
}

/**
 * Least number of `NAVIGATES_TO` steps from `start` to every screen it reaches, by breadth-first search over the
 * outgoing navigations. A screen is visited once, so a cycle neither loops nor changes a distance. `start` itself is
 * not in the result.
 */
function depthsFrom(graph: Graph, start: string): Map<string, number> {
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'NAVIGATES_TO') continue;
    const list = outgoing.get(edge.source);
    if (list === undefined) outgoing.set(edge.source, [edge.target]);
    else list.push(edge.target);
  }
  const seen = new Set<string>([start]);
  const depths = new Map<string, number>();
  let frontier = [start];
  for (let depth = 1; frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const key of frontier) {
      for (const target of outgoing.get(key) ?? []) {
        if (seen.has(target)) continue;
        seen.add(target);
        depths.set(target, depth);
        next.push(target);
      }
    }
    frontier = next;
  }
  return depths;
}

/** The 10 screens with the most connections, in reading order (depth, connections, name, id; unreachable last). */
function selectKeyScreens(graph: Graph, appContext: ScreenNode): KeyScreen[] {
  const screens = graph.nodes.filter((n): n is ScreenNode => n.type === 'SCREEN' && !n.isAppContext);
  const neighbors = neighborsOfScreens(graph, new Set(screens.map((s) => s.key)));
  const depths = depthsFrom(graph, appContext.key);
  const rows = screens.map((screen) => ({
    screen: { id: screen.id, name: screen.name },
    documentationStatus: screen.documentationStatus,
    connections: neighbors.get(screen.key)?.size ?? 0,
    depth: depths.get(screen.key) ?? null,
    miroLink: screen.miroLink,
  }));
  const chosen = rows.sort((a, b) => b.connections - a.connections || byName(a.screen, b.screen)).slice(0, LIST_LIMIT);
  return chosen.sort(
    (a, b) => compareDepth(a.depth, b.depth) || b.connections - a.connections || byName(a.screen, b.screen),
  );
}

/** The 10 `GLOBAL` variables read or written by the most different screens (the `origin` row is not an edge). */
function selectGlobalVariables(graph: Graph, nodes: ReadonlyMap<string, GraphNode>): GlobalVariableCandidate[] {
  const users = new Map<string, Set<string>>();
  const origin = new Map<string, string>();
  for (const edge of graph.edges) {
    if (edge.kind === 'ACCESSES' && edge.source.startsWith('screen:') && edge.target.startsWith('variable:')) {
      const set = users.get(edge.target);
      if (set === undefined) users.set(edge.target, new Set([edge.source]));
      else set.add(edge.source);
    } else if (edge.kind === 'CREATES') {
      origin.set(edge.target, edge.source);
    }
  }
  const rows: GlobalVariableCandidate[] = [];
  for (const node of graph.nodes) {
    if (node.type !== 'VARIABLE' || node.scope !== 'GLOBAL') continue;
    const originNode = nodes.get(origin.get(node.key) ?? '');
    rows.push({
      variable: { id: node.id, name: node.name },
      originScreen: originNode === undefined ? null : { id: originNode.id, name: originNode.name },
      usedByScreens: users.get(node.key)?.size ?? 0,
    });
  }
  return rows.sort((a, b) => b.usedByScreens - a.usedByScreens || byName(a.variable, b.variable)).slice(0, LIST_LIMIT);
}

/** The 10 components with the most `USES` edges as their source (D-50); a component that uses nothing is not listed. */
function selectTopComponents(graph: Graph, nodes: ReadonlyMap<string, GraphNode>): TopComponent[] {
  const uses = new Map<string, number>();
  for (const edge of graph.edges) {
    if (edge.kind === 'USES' && edge.source.startsWith('component:')) {
      uses.set(edge.source, (uses.get(edge.source) ?? 0) + 1);
    }
  }
  const rows: TopComponent[] = [];
  for (const node of graph.nodes) {
    if (node.type !== 'COMPONENT') continue;
    const count = uses.get(node.key) ?? 0;
    if (count === 0) continue;
    const screen = nodes.get(`screen:${node.screenId}`);
    if (screen === undefined) throw new Error(`the graph has no screen for ${node.key}`);
    rows.push({
      component: { id: node.id, name: node.name },
      screen: { id: screen.id, name: screen.name },
      uses: count,
    });
  }
  return rows
    .sort(
      (a, b) =>
        b.uses - a.uses ||
        compareCodePoints(a.component.name, b.component.name) ||
        compareCodePoints(a.screen.name, b.screen.name) ||
        a.component.id - b.component.id,
    )
    .slice(0, LIST_LIMIT);
}

/**
 * Derives the parts of the summary that the dependency graph holds.
 *
 * @param graph - The graph of the application, as `graphOn` returns it.
 * @throws {Error} When the application has no App (OnStart) screen: the database guarantees one, so it is an
 *   invariant violation (answered as a 500), never a client error.
 */
export function summarizeGraph(graph: Graph): GraphParts {
  const nodes = new Map(graph.nodes.map((node) => [node.key, node]));
  const appContext = graph.nodes.find((n): n is ScreenNode => n.type === 'SCREEN' && n.isAppContext);
  if (appContext === undefined) throw new Error('the graph has no App (OnStart) screen');
  return {
    componentCount: graph.nodes.filter((n) => n.type === 'COMPONENT').length,
    appContext: {
      id: appContext.id,
      name: appContext.name,
      documentationStatus: appContext.documentationStatus,
      miroLink: appContext.miroLink,
    },
    keyScreens: selectKeyScreens(graph, appContext),
    globalVariables: selectGlobalVariables(graph, nodes),
    topComponents: selectTopComponents(graph, nodes),
  };
}
