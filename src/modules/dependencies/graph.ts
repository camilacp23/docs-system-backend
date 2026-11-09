/**
 * Pure rules of the dependency map (FR-15, FR-16; Table 63; contract schemas `GraphNode` and `GraphEdge`).
 *
 * `graph.sql` returns one JSON document per application with snake_case keys and `null` for every field that does not
 * apply. This module turns it into the contract's variants (each node and edge declares only its own fields, in
 * camelCase), removes the edges that point to a node that is not in the response, orders everything
 * deterministically (the ETag is a hash of the body) and walks the neighborhood of one node. It has no database and
 * no HTTP: the service feeds it.
 *
 * @module modules/dependencies/graph
 */

/** The four kinds of node, in the order of the response. */
export const NODE_TYPES = ['SCREEN', 'VARIABLE', 'COLLECTION', 'COMPONENT'] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** The edge kinds, in the order of SDD Table 63. */
export const EDGE_KINDS = ['CONTAINS', 'CREATES', 'ACCESSES', 'FEEDS', 'USES', 'DERIVES_FROM', 'NAVIGATES_TO'] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/** A node as `graph.sql` returns it (column names of its `nodes` CTE). */
export type RawNode = {
  key: string;
  id: number;
  type: NodeType;
  name: string;
  screen_id: number | null;
  documentation_status: string | null;
  is_app_context: boolean | null;
  scope: string | null;
  untraced: boolean | null;
  miro_link: string | null;
};

/** An edge as `graph.sql` returns it (column names of its `edges` CTE). */
export type RawEdge = {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  access_mode: string | null;
  used_in: string | null;
  assignment_function: string | null;
  table_function: string | null;
};

/** The document `graph.sql` returns. */
export type RawGraph = { nodes: RawNode[]; edges: RawEdge[] };

type NodeBase = { key: string; id: number; name: string };
export type ScreenNode = NodeBase & {
  type: 'SCREEN';
  documentationStatus: string;
  isAppContext: boolean;
  miroLink: string | null;
};
export type VariableNode = NodeBase & { type: 'VARIABLE'; scope: string; untraced: boolean };
export type CollectionNode = NodeBase & { type: 'COLLECTION' };
export type ComponentNode = NodeBase & { type: 'COMPONENT'; screenId: number };
/** A node of the contract (`GraphNode`). */
export type GraphNode = ScreenNode | VariableNode | CollectionNode | ComponentNode;

type EdgeBase = { id: string; source: string; target: string };
export type AccessEdge = EdgeBase & { kind: 'ACCESSES'; accessMode: string; usedIn: string };
export type FeedEdge = EdgeBase & {
  kind: 'FEEDS';
  usedIn: string;
  assignmentFunction: string;
  tableFunction: string | null;
};
export type StructureEdge = EdgeBase & { kind: Exclude<EdgeKind, 'ACCESSES' | 'FEEDS'> };
/** An edge of the contract (`GraphEdge`). */
export type GraphEdge = AccessEdge | FeedEdge | StructureEdge;

/** The body of `GET /dependencies/graph` and of the neighborhood, inside `data`. */
export type Graph = { nodes: GraphNode[]; edges: GraphEdge[] };

const NODE_RANK: ReadonlyMap<string, number> = new Map(NODE_TYPES.map((type, index) => [type, index]));
const EDGE_RANK: ReadonlyMap<string, number> = new Map(EDGE_KINDS.map((kind, index) => [kind, index]));

/** Path segment of each node type (`/dependencies/{type}/{id}`). */
const TYPE_OF_SEGMENT: ReadonlyMap<string, NodeType> = new Map<string, NodeType>([
  ['screens', 'SCREEN'],
  ['variables', 'VARIABLE'],
  ['collections', 'COLLECTION'],
  ['components', 'COMPONENT'],
]);

/**
 * Node type of the plural used in the path of the neighborhood.
 *
 * @param segment - `screens`, `variables`, `collections` or `components`.
 * @returns The node type, or `undefined` for anything else.
 */
export function nodeTypeOfSegment(segment: string): NodeType | undefined {
  return TYPE_OF_SEGMENT.get(segment);
}

/**
 * Key of a node (`<type in lowercase>:<id>`).
 *
 * @param type - Node type.
 * @param id - Element id.
 */
export function nodeKey(type: NodeType, id: number): string {
  return `${type.toLowerCase()}:${id}`;
}

/** A field the query must have filled for the variant: absent means the data broke the contract of the query. */
function required<T>(value: T | null, field: string, owner: string): T {
  if (value === null) throw new Error(`graph query returned no ${field} for ${owner}`);
  return value;
}

/** The contract's node of a row of `graph.sql`; only the fields of its variant. */
function toNode(raw: RawNode): GraphNode {
  const base = { key: raw.key, id: raw.id, name: raw.name };
  switch (raw.type) {
    case 'SCREEN':
      return {
        ...base,
        type: 'SCREEN',
        documentationStatus: required(raw.documentation_status, 'documentation_status', raw.key),
        isAppContext: required(raw.is_app_context, 'is_app_context', raw.key),
        miroLink: raw.miro_link,
      };
    case 'VARIABLE':
      return {
        ...base,
        type: 'VARIABLE',
        scope: required(raw.scope, 'scope', raw.key),
        untraced: required(raw.untraced, 'untraced', raw.key),
      };
    case 'COLLECTION':
      return { ...base, type: 'COLLECTION' };
    case 'COMPONENT':
      return { ...base, type: 'COMPONENT', screenId: required(raw.screen_id, 'screen_id', raw.key) };
  }
}

/** The contract's edge of a row of `graph.sql`; only the fields of its variant. */
function toEdge(raw: RawEdge): GraphEdge {
  const base = { id: raw.id, source: raw.source, target: raw.target };
  switch (raw.kind) {
    case 'ACCESSES':
      return {
        ...base,
        kind: 'ACCESSES',
        accessMode: required(raw.access_mode, 'access_mode', raw.id),
        usedIn: required(raw.used_in, 'used_in', raw.id),
      };
    case 'FEEDS':
      return {
        ...base,
        kind: 'FEEDS',
        usedIn: required(raw.used_in, 'used_in', raw.id),
        assignmentFunction: required(raw.assignment_function, 'assignment_function', raw.id),
        tableFunction: raw.table_function,
      };
    default:
      return { ...base, kind: raw.kind };
  }
}

/** Splits an edge id (`sc:5`) into its prefix and the number of the row it comes from. */
function parseEdgeId(id: string): { prefix: string; row: number } {
  const colon = id.indexOf(':');
  return { prefix: id.slice(0, colon), row: Number(id.slice(colon + 1)) };
}

/** Nodes by type (`SCREEN`, `VARIABLE`, `COLLECTION`, `COMPONENT`) and then by `id` ascending. */
export function compareNodes(a: GraphNode, b: GraphNode): number {
  return (NODE_RANK.get(a.type) ?? 0) - (NODE_RANK.get(b.type) ?? 0) || a.id - b.id;
}

/** Edges by `kind` (Table 63 order), then by the row number of the id and, if equal, by its prefix. */
export function compareEdges(a: GraphEdge, b: GraphEdge): number {
  const left = parseEdgeId(a.id);
  const right = parseEdgeId(b.id);
  return (
    (EDGE_RANK.get(a.kind) ?? 0) - (EDGE_RANK.get(b.kind) ?? 0) ||
    left.row - right.row ||
    (left.prefix < right.prefix ? -1 : left.prefix > right.prefix ? 1 : 0)
  );
}

/**
 * Keeps the edges whose two ends are in `nodes` (an edge with an end left out is removed: never a dangling edge) and
 * returns both lists in the deterministic order.
 *
 * @param nodes - Nodes of the response.
 * @param edges - Candidate edges.
 */
export function assemble(nodes: GraphNode[], edges: GraphEdge[]): Graph {
  const present = new Set(nodes.map((node) => node.key));
  return {
    nodes: [...nodes].sort(compareNodes),
    edges: edges.filter((edge) => present.has(edge.source) && present.has(edge.target)).sort(compareEdges),
  };
}

/**
 * The graph of one application in the shape of the contract.
 *
 * @param raw - Document returned by `graph.sql`.
 */
export function toGraph(raw: RawGraph): Graph {
  return assemble(raw.nodes.map(toNode), raw.edges.map(toEdge));
}

/** Filters of `GET /dependencies/graph`. */
export type GraphFilters = {
  /** Keep only these node types (undefined or empty = all four). */
  types?: readonly NodeType[] | undefined;
  /** Keys (`variable:7`, `collection:21`) present in the requested environment; undefined = no environment filter. */
  inEnvironment?: ReadonlySet<string> | undefined;
};

/**
 * Applies `types` and `environment` (the latter touches only `VARIABLE` and `COLLECTION`), then drops the edges that
 * lost an end.
 *
 * @param graph - Complete graph of the application.
 * @param filters - Optional filters.
 */
export function filterGraph(graph: Graph, filters: GraphFilters): Graph {
  const types = filters.types !== undefined && filters.types.length > 0 ? new Set<string>(filters.types) : undefined;
  const kept = graph.nodes.filter((node) => {
    if (types !== undefined && !types.has(node.type)) return false;
    if (filters.inEnvironment === undefined) return true;
    const filtered = node.type === 'VARIABLE' || node.type === 'COLLECTION';
    return !filtered || filters.inEnvironment.has(node.key);
  });
  return assemble(kept, graph.edges);
}

/**
 * The node `centerKey` and the nodes reachable from it in at most `depth` steps, following the edges in both
 * directions, with every edge of the graph between those nodes (the induced subgraph). A node is visited once, so
 * cycles (a collection that derives from itself through others) neither loop nor duplicate anything.
 *
 * @param graph - Complete graph of the application.
 * @param centerKey - Key of the node to start from.
 * @param depth - Steps, 1 to 3.
 */
export function neighborhood(graph: Graph, centerKey: string, depth: number): Graph {
  const adjacent = new Map<string, string[]>();
  const link = (from: string, to: string): void => {
    const list = adjacent.get(from);
    if (list === undefined) adjacent.set(from, [to]);
    else list.push(to);
  };
  for (const edge of graph.edges) {
    link(edge.source, edge.target);
    link(edge.target, edge.source);
  }

  const visited = new Set<string>([centerKey]);
  let frontier = [centerKey];
  for (let step = 0; step < depth && frontier.length > 0; step += 1) {
    const next: string[] = [];
    for (const key of frontier) {
      for (const other of adjacent.get(key) ?? []) {
        if (!visited.has(other)) {
          visited.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  return assemble(
    graph.nodes.filter((node) => visited.has(node.key)),
    graph.edges,
  );
}
