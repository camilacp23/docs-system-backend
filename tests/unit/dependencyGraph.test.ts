/**
 * Pure rules of the dependency map (FR-15, FR-16): variants without foreign fields, camelCase, order, filters without
 * dangling edges, and the neighborhood walk with cycles. No database and no server.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  filterGraph,
  neighborhood,
  nodeKey,
  nodeTypeOfSegment,
  toGraph,
  type RawEdge,
  type RawGraph,
  type RawNode,
} from '../../src/modules/dependencies/graph.js';

const node = (type: RawNode['type'], id: number, over: Partial<RawNode> = {}): RawNode => ({
  key: nodeKey(type, id),
  id,
  type,
  name: `${type.toLowerCase()}${id}`,
  screen_id: null,
  documentation_status: null,
  is_app_context: null,
  scope: null,
  untraced: null,
  miro_link: null,
  ...over,
});
const screen = (id: number, over: Partial<RawNode> = {}) =>
  node('SCREEN', id, { documentation_status: 'DRAFT', is_app_context: false, ...over });
const variable = (id: number, over: Partial<RawNode> = {}) =>
  node('VARIABLE', id, { scope: 'GLOBAL', untraced: false, ...over });
const collection = (id: number) => node('COLLECTION', id);
const component = (id: number, screenId: number) => node('COMPONENT', id, { screen_id: screenId });

const edge = (
  id: string,
  kind: RawEdge['kind'],
  source: string,
  target: string,
  over: Partial<RawEdge> = {},
): RawEdge => ({
  id,
  source,
  target,
  kind,
  access_mode: null,
  used_in: null,
  assignment_function: null,
  table_function: null,
  ...over,
});

describe('toGraph: variants', () => {
  const raw: RawGraph = {
    nodes: [
      screen(1, { is_app_context: true, documentation_status: 'APPROVED', miro_link: 'https://miro.com/x' }),
      screen(2),
      variable(7, { scope: 'CONTEXT', untraced: true }),
      collection(21),
      component(31, 2),
    ],
    edges: [
      edge('ct:31', 'CONTAINS', 'screen:2', 'component:31'),
      edge('sc:5', 'ACCESSES', 'screen:2', 'collection:21', { access_mode: 'READ', used_in: 'OnVisible' }),
      edge('vc:3', 'FEEDS', 'collection:21', 'variable:7', {
        used_in: 'OnStart',
        assignment_function: 'SET',
        table_function: null,
      }),
    ],
  };
  const graph = toGraph(raw);

  it('each node declares only its own fields, in camelCase', () => {
    const keys = (key: string) => Object.keys(graph.nodes.find((n) => n.key === key)!).sort();
    assert.deepEqual(keys('screen:1'), [
      'documentationStatus',
      'id',
      'isAppContext',
      'key',
      'miroLink',
      'name',
      'type',
    ]);
    assert.deepEqual(keys('variable:7'), ['id', 'key', 'name', 'scope', 'type', 'untraced']);
    assert.deepEqual(keys('collection:21'), ['id', 'key', 'name', 'type']);
    assert.deepEqual(keys('component:31'), ['id', 'key', 'name', 'screenId', 'type']);
  });

  it('a screen without a diagram has miroLink null, and App (OnStart) is recognised by isAppContext', () => {
    assert.equal(graph.nodes.find((n) => n.key === 'screen:2')!['miroLink' as never], null);
    assert.equal(graph.nodes.find((n) => n.key === 'screen:1')!['isAppContext' as never], true);
  });

  it('each edge declares only its own fields', () => {
    const keys = (id: string) => Object.keys(graph.edges.find((e) => e.id === id)!).sort();
    assert.deepEqual(keys('ct:31'), ['id', 'kind', 'source', 'target']);
    assert.deepEqual(keys('sc:5'), ['accessMode', 'id', 'kind', 'source', 'target', 'usedIn']);
    assert.deepEqual(keys('vc:3'), ['assignmentFunction', 'id', 'kind', 'source', 'tableFunction', 'target', 'usedIn']);
  });

  it('FEEDS keeps tableFunction as null when the assignment has none', () => {
    const feed = graph.edges.find((e) => e.id === 'vc:3')!;
    assert.equal(feed.kind === 'FEEDS' && feed.tableFunction, null);
  });

  it('a row that breaks the contract of the query is an error, never a silent null', () => {
    assert.throws(() => toGraph({ nodes: [node('VARIABLE', 1)], edges: [] }), /scope/);
    assert.throws(
      () =>
        toGraph({ nodes: [screen(1), collection(2)], edges: [edge('sc:1', 'ACCESSES', 'screen:1', 'collection:2')] }),
      /access_mode/,
    );
  });
});

describe('toGraph: order', () => {
  it('nodes by type and then by id, whatever the order of the query', () => {
    const graph = toGraph({
      nodes: [component(3, 1), collection(9), variable(2), screen(10), screen(2), variable(1), collection(4)],
      edges: [],
    });
    assert.deepEqual(
      graph.nodes.map((n) => n.key),
      ['screen:2', 'screen:10', 'variable:1', 'variable:2', 'collection:4', 'collection:9', 'component:3'],
    );
  });

  it('edges by kind, then by the row number (numeric), then by prefix', () => {
    const nodes = [screen(1), screen(2), variable(1), collection(1), component(1, 1)];
    const access = { access_mode: 'READ', used_in: 'x' };
    const graph = toGraph({
      nodes,
      edges: [
        edge('d:1', 'NAVIGATES_TO', 'screen:1', 'screen:2'),
        edge('sv:5', 'ACCESSES', 'screen:1', 'variable:1', access),
        edge('sc:5', 'ACCESSES', 'screen:1', 'collection:1', access),
        edge('sc:10', 'ACCESSES', 'screen:2', 'collection:1', access),
        edge('sc:9', 'ACCESSES', 'screen:2', 'collection:1', access),
        edge('cr:1', 'CREATES', 'screen:1', 'variable:1'),
        edge('ct:1', 'CONTAINS', 'screen:1', 'component:1'),
        edge('d:2', 'USES', 'component:1', 'variable:1'),
        edge('d:3', 'DERIVES_FROM', 'collection:1', 'collection:1'),
      ],
    });
    assert.deepEqual(
      graph.edges.map((e) => e.id),
      ['ct:1', 'cr:1', 'sc:5', 'sv:5', 'sc:9', 'sc:10', 'd:2', 'd:3', 'd:1'],
    );
  });

  it('the same input in another order gives the same output', () => {
    const raw: RawGraph = {
      nodes: [screen(1), screen(2), collection(3)],
      edges: [edge('d:1', 'NAVIGATES_TO', 'screen:1', 'screen:2'), edge('d:2', 'NAVIGATES_TO', 'screen:2', 'screen:1')],
    };
    const reversed: RawGraph = { nodes: [...raw.nodes].reverse(), edges: [...raw.edges].reverse() };
    assert.equal(JSON.stringify(toGraph(raw)), JSON.stringify(toGraph(reversed)));
  });
});

describe('toGraph: no dangling edges', () => {
  it('an edge whose end is not a node of the response is removed', () => {
    const graph = toGraph({ nodes: [screen(1)], edges: [edge('ct:1', 'CONTAINS', 'screen:1', 'component:1')] });
    assert.deepEqual(graph.edges, []);
  });
});

describe('filterGraph', () => {
  const full = toGraph({
    nodes: [screen(1), screen(2), variable(1), variable(2), collection(1), component(1, 2)],
    edges: [
      edge('ct:1', 'CONTAINS', 'screen:2', 'component:1'),
      edge('cr:1', 'CREATES', 'screen:1', 'variable:1'),
      edge('d:1', 'USES', 'component:1', 'variable:2'),
      edge('d:2', 'NAVIGATES_TO', 'screen:1', 'screen:2'),
    ],
  });

  it('without filters nothing changes', () => {
    assert.deepEqual(filterGraph(full, {}), full);
    assert.deepEqual(filterGraph(full, { types: [] }), full);
  });

  it('types keeps those nodes and only the edges between them', () => {
    const only = filterGraph(full, { types: ['SCREEN'] });
    assert.deepEqual(
      only.nodes.map((n) => n.key),
      ['screen:1', 'screen:2'],
    );
    assert.deepEqual(
      only.edges.map((e) => e.id),
      ['d:2'],
    );
  });

  it('a component keeps its screenId although the screens were filtered out', () => {
    const only = filterGraph(full, { types: ['COMPONENT'] });
    assert.equal(only.nodes.length, 1);
    assert.equal(only.nodes[0]!.type === 'COMPONENT' && only.nodes[0]!.screenId, 2);
    assert.deepEqual(only.edges, []);
  });

  it('environment filters variables and collections only; screens and components stay', () => {
    const dev = filterGraph(full, { inEnvironment: new Set(['variable:2']) });
    assert.deepEqual(
      dev.nodes.map((n) => n.key),
      ['screen:1', 'screen:2', 'variable:2', 'component:1'],
    );
    assert.deepEqual(
      dev.edges.map((e) => e.id),
      ['ct:1', 'd:1', 'd:2'],
    );
  });

  it('types and environment combine, and an empty environment leaves no variable or collection', () => {
    const none = filterGraph(full, { types: ['VARIABLE', 'COLLECTION'], inEnvironment: new Set() });
    assert.deepEqual(none, { nodes: [], edges: [] });
    const some = filterGraph(full, { types: ['VARIABLE', 'COMPONENT'], inEnvironment: new Set(['variable:2']) });
    assert.deepEqual(
      some.nodes.map((n) => n.key),
      ['variable:2', 'component:1'],
    );
    assert.deepEqual(
      some.edges.map((e) => e.id),
      ['d:1'],
    );
  });
});

describe('neighborhood', () => {
  // screen:1 -> screen:2 -> screen:3 -> screen:1 (cycle); collection:1 <-> collection:2 (cycle); screen:4 far away.
  const graph = toGraph({
    nodes: [screen(1), screen(2), screen(3), screen(4), collection(1), collection(2)],
    edges: [
      edge('d:1', 'NAVIGATES_TO', 'screen:1', 'screen:2'),
      edge('d:2', 'NAVIGATES_TO', 'screen:2', 'screen:3'),
      edge('d:3', 'NAVIGATES_TO', 'screen:3', 'screen:1'),
      edge('d:4', 'NAVIGATES_TO', 'screen:3', 'screen:4'),
      edge('d:5', 'DERIVES_FROM', 'collection:1', 'collection:2'),
      edge('d:6', 'DERIVES_FROM', 'collection:2', 'collection:1'),
      edge('sc:1', 'ACCESSES', 'screen:4', 'collection:1', { access_mode: 'READ', used_in: 'x' }),
    ],
  });
  const keys = (g: { nodes: { key: string }[] }) => g.nodes.map((n) => n.key);

  it('depth 1 follows the edges in both directions', () => {
    assert.deepEqual(keys(neighborhood(graph, 'screen:1', 1)), ['screen:1', 'screen:2', 'screen:3']);
  });

  it('includes the edge between two neighbors, not only the ones walked', () => {
    assert.deepEqual(
      neighborhood(graph, 'screen:1', 1).edges.map((e) => e.id),
      ['d:1', 'd:2', 'd:3'],
    );
  });

  it('depth 2 and 3 reach further, each node once, however many cycles there are', () => {
    assert.deepEqual(keys(neighborhood(graph, 'screen:1', 2)), ['screen:1', 'screen:2', 'screen:3', 'screen:4']);
    const three = neighborhood(graph, 'screen:1', 3);
    assert.deepEqual(keys(three), ['screen:1', 'screen:2', 'screen:3', 'screen:4', 'collection:1']);
    assert.equal(new Set(three.edges.map((e) => e.id)).size, three.edges.length);
  });

  it('a two-collection cycle returns both once, with both edges', () => {
    const around = neighborhood(graph, 'collection:2', 3);
    assert.equal(around.nodes.filter((n) => n.key === 'collection:1').length, 1);
    assert.deepEqual(
      around.edges.filter((e) => e.kind === 'DERIVES_FROM').map((e) => e.id),
      ['d:5', 'd:6'],
    );
  });

  it('an isolated node is alone, and the order is the one of the graph', () => {
    const lonely = toGraph({ nodes: [screen(9)], edges: [] });
    assert.deepEqual(neighborhood(lonely, 'screen:9', 3), lonely);
    assert.deepEqual(keys(neighborhood(graph, 'collection:1', 1)), ['screen:4', 'collection:1', 'collection:2']);
  });
});

describe('nodeTypeOfSegment', () => {
  it('maps the four plurals and nothing else', () => {
    assert.equal(nodeTypeOfSegment('screens'), 'SCREEN');
    assert.equal(nodeTypeOfSegment('variables'), 'VARIABLE');
    assert.equal(nodeTypeOfSegment('collections'), 'COLLECTION');
    assert.equal(nodeTypeOfSegment('components'), 'COMPONENT');
    assert.equal(nodeTypeOfSegment('screen'), undefined);
    assert.equal(nodeTypeOfSegment('constructor'), undefined);
  });
});
