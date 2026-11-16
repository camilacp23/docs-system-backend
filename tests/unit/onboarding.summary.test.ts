/**
 * The rules of the onboarding summary (FR-25, D-124) on hand-made graphs: connections, key screens and their reading
 * order, depth by breadth-first search, global variables, top components and the order by code point (D-110). Each
 * rule has data built to break its tie, so a wrong tie-break gives another order.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Graph, GraphEdge, GraphNode } from '../../src/modules/dependencies/graph.js';
import { compareCodePoints, LIST_LIMIT, summarizeGraph } from '../../src/modules/onboarding/summary.js';

const APP = 1;

const screen = (
  id: number,
  name: string,
  over: { app?: boolean; status?: string; miro?: string | null } = {},
): GraphNode => ({
  key: `screen:${id}`,
  id,
  type: 'SCREEN',
  name,
  documentationStatus: over.status ?? 'DRAFT',
  isAppContext: over.app ?? false,
  miroLink: over.miro ?? null,
});
const variable = (id: number, name: string, scope = 'GLOBAL'): GraphNode => ({
  key: `variable:${id}`,
  id,
  type: 'VARIABLE',
  name,
  scope,
  untraced: false,
});
const collection = (id: number, name: string): GraphNode => ({ key: `collection:${id}`, id, type: 'COLLECTION', name });
const component = (id: number, name: string, screenId: number): GraphNode => ({
  key: `component:${id}`,
  id,
  type: 'COMPONENT',
  name,
  screenId,
});

let edgeCounter = 0;
const edge = (kind: GraphEdge['kind'], source: string, target: string): GraphEdge => {
  edgeCounter += 1;
  const id = `e:${edgeCounter}`;
  if (kind === 'ACCESSES') return { id, source, target, kind, accessMode: 'READ', usedIn: `u${edgeCounter}` };
  if (kind === 'FEEDS') {
    return { id, source, target, kind, usedIn: 'x', assignmentFunction: 'SET', tableFunction: null };
  }
  return { id, source, target, kind };
};
const nav = (from: number, to: number): GraphEdge => edge('NAVIGATES_TO', `screen:${from}`, `screen:${to}`);
const access = (screenId: number, target: string): GraphEdge => edge('ACCESSES', `screen:${screenId}`, target);
const uses = (componentId: number, target: string): GraphEdge => edge('USES', `component:${componentId}`, target);

/** The graph of an application: App (OnStart) (id 1) and what the test adds. */
const graphOf = (nodes: GraphNode[], edges: GraphEdge[] = []): Graph => ({
  nodes: [screen(APP, 'App (OnStart)', { app: true, status: 'APPROVED' }), ...nodes],
  edges,
});

describe('onboarding: compareCodePoints (D-110)', () => {
  it('orders by code point, like COLLATE "C"', () => {
    assert.ok(compareCodePoints('Zeta', 'alfa') < 0, 'uppercase before lowercase');
    assert.ok(compareCodePoints('9', 'A') < 0, 'digits before letters');
    assert.ok(compareCodePoints('_a', 'a') < 0);
    assert.ok(compareCodePoints('z', 'ñ') < 0, 'ñ after z');
    assert.ok(compareCodePoints('Ñ', 'a') > 0, 'a letter outside ASCII after every ASCII one, whatever its case');
    assert.ok(compareCodePoints('Inicio', 'Inicio 2') < 0, 'a prefix first');
    assert.equal(compareCodePoints('abc', 'abc'), 0);
  });

  it('compares a character outside the BMP by its code point, not by its UTF-16 units', () => {
    const astral = '\u{1F600}'; // U+1F600, units D83D DE00
    const high = '～'; // U+FF5E: a greater UTF-16 unit than D83D, but a smaller code point
    // By UTF-16 units the astral character sorts BEFORE U+FF5E; by code point it sorts after. PostgreSQL "C" is the latter.
    assert.ok(astral < high, 'plain < is the wrong order for this pair');
    assert.ok(compareCodePoints(astral, high) > 0);
    assert.ok(compareCodePoints(high, astral) < 0);
    assert.ok(compareCodePoints(`a${astral}b`, `a${astral}c`) < 0);
  });

  it('never uses the locale: a string order that localeCompare would reverse', () => {
    assert.ok('a'.localeCompare('B') < 0);
    assert.ok(compareCodePoints('a', 'B') > 0);
  });
});

describe('onboarding: connections (D-124)', () => {
  const connectionsOf = (graph: Graph, id: number): number | undefined =>
    summarizeGraph(graph).keyScreens.find((k) => k.screen.id === id)?.connections;

  it('counts different screens, variables and collections, in both directions', () => {
    const graph = graphOf(
      [screen(2, 'Home'), screen(3, 'Detail'), screen(4, 'Back'), variable(10, 'gA'), collection(20, 'colA')],
      [nav(2, 3), nav(4, 2), access(2, 'variable:10'), access(2, 'collection:20')],
    );
    assert.equal(connectionsOf(graph, 2), 4); // Detail (out), Back (in), gA, colA
    assert.equal(connectionsOf(graph, 3), 1);
    assert.equal(connectionsOf(graph, 4), 1);
  });

  it('counts a neighbor once, however many edges link it', () => {
    const graph = graphOf(
      [screen(2, 'Home'), screen(3, 'Detail'), variable(10, 'gA')],
      [
        access(2, 'variable:10'), // several usedIn
        access(2, 'variable:10'),
        access(2, 'variable:10'),
        edge('CREATES', 'screen:2', 'variable:10'), // creates and also reads it
        nav(2, 3),
        nav(3, 2), // both directions
      ],
    );
    assert.equal(connectionsOf(graph, 2), 2); // gA once, Detail once
    assert.equal(connectionsOf(graph, 3), 1);
  });

  it('does not count CONTAINS, FEEDS, USES or DERIVES_FROM', () => {
    const graph = graphOf(
      [screen(2, 'Home'), component(30, 'btn', 2), variable(10, 'gA'), collection(20, 'colA')],
      [
        edge('CONTAINS', 'screen:2', 'component:30'),
        uses(30, 'variable:10'),
        edge('FEEDS', 'collection:20', 'variable:10'),
        edge('DERIVES_FROM', 'collection:20', 'collection:20'),
      ],
    );
    assert.equal(connectionsOf(graph, 2), 0);
  });

  it('counts App (OnStart) as a neighbor screen (D-124)', () => {
    const graph = graphOf([screen(2, 'Home'), screen(3, 'Other')], [nav(APP, 2), nav(3, APP)]);
    assert.equal(connectionsOf(graph, 2), 1);
    assert.equal(connectionsOf(graph, 3), 1);
  });
});

describe('onboarding: key screens (D-124)', () => {
  it('never lists App (OnStart), even when it is the most connected', () => {
    const graph = graphOf([screen(2, 'Home'), screen(3, 'Detail')], [nav(APP, 2), nav(APP, 3), nav(2, 3)]);
    const ids = summarizeGraph(graph).keyScreens.map((k) => k.screen.id);
    assert.deepEqual([...ids].sort(), [2, 3]);
  });

  it('chooses the 10 most connected: ties by name by code point, then by id', () => {
    // 13 screens, all with exactly 1 connection (one variable each) except 3 with 2.
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const names = ['b', 'a', 'B', 'A', 'ñ', 'z', 'Z', 'c', 'C', 'd', 'D', 'e'];
    names.forEach((name, index) => {
      const id = 10 + index;
      nodes.push(screen(id, name), variable(100 + index, `v${index}`));
      edges.push(access(id, `variable:${100 + index}`));
    });
    // Same name, other id: the id breaks this tie.
    nodes.push(screen(40, 'a'), variable(140, 'v40'));
    edges.push(access(40, 'variable:140'));
    // Two more connections for 'e' and 'D': they must be chosen first.
    nodes.push(variable(150, 'extra1'), variable(151, 'extra2'));
    edges.push(access(21, 'variable:150'), access(21, 'variable:151'), access(20, 'variable:150'));

    const chosen = summarizeGraph(graphOf(nodes, edges)).keyScreens.map((k) => k.screen.name + k.screen.id);
    assert.equal(chosen.length, LIST_LIMIT);
    // 'e' (id 21) has 3 connections and 'D' (id 20) has 2. The other 11 have 1, by code point: A B C Z a a b c d z ñ.
    // The first 8 are A B C Z a(11) a(40) b c; 'd', 'z' and 'ñ' stay out. The two 'a' are told apart by id.
    assert.deepEqual([...chosen].sort(), ['A13', 'B12', 'C18', 'D20', 'Z16', 'a11', 'a40', 'b10', 'c17', 'e21'].sort());
  });

  it('lists them by depth ascending, then connections descending, name and id; unreachable ones last', () => {
    const graph = graphOf(
      [
        screen(2, 'Home'), // depth 1, 3 connections (App, List, gA)
        screen(3, 'Alpha'), // depth 1, 3 connections (App, gB, gC): same as Home, so the name decides
        screen(4, 'List'), // depth 2, 5 connections: more than Home, but deeper
        screen(5, 'Detail'), // depth 3, 2 connections
        screen(6, 'Orphan'), // unreachable, 5 connections: still last
        screen(7, 'Island'), // unreachable, 2 connections
        variable(10, 'gA'),
        variable(11, 'gB'),
        variable(12, 'gC'),
        variable(13, 'gD'),
        variable(14, 'gE'),
        variable(15, 'gF'),
      ],
      [
        nav(APP, 2),
        nav(APP, 3),
        nav(2, 4),
        nav(4, 5),
        access(2, 'variable:10'),
        access(3, 'variable:11'),
        access(3, 'variable:12'),
        access(4, 'variable:12'),
        access(4, 'variable:13'),
        access(4, 'variable:14'),
        access(5, 'variable:15'),
        ...[10, 11, 12, 13, 14].map((v) => access(6, `variable:${v}`)),
        access(7, 'variable:10'),
        access(7, 'variable:11'),
      ],
    );
    const result = summarizeGraph(graph).keyScreens;
    assert.deepEqual(
      result.map((k) => [k.screen.name, k.depth]),
      [
        ['Alpha', 1],
        ['Home', 1],
        ['List', 2],
        ['Detail', 3],
        ['Orphan', null],
        ['Island', null],
      ],
    );
  });

  it('computes depth as the least NAVIGATES_TO distance, not the first found', () => {
    const graph = graphOf(
      [screen(2, 'A'), screen(3, 'B'), screen(4, 'C')],
      [nav(APP, 2), nav(2, 3), nav(3, 4), nav(APP, 4)], // C is 3 steps through A and B, 1 step directly
    );
    const depth = Object.fromEntries(summarizeGraph(graph).keyScreens.map((k) => [k.screen.name, k.depth]));
    assert.deepEqual(depth, { A: 1, B: 2, C: 1 });
  });

  it('follows only outgoing navigations: the reverse direction does not reach a screen', () => {
    const graph = graphOf([screen(2, 'Back')], [nav(2, APP)]);
    assert.equal(summarizeGraph(graph).keyScreens[0]?.depth, null);
  });

  it('survives navigation cycles, a self-reaching loop and a cycle that returns to App (OnStart)', () => {
    const graph = graphOf(
      [screen(2, 'A'), screen(3, 'B'), screen(4, 'C'), screen(5, 'X'), screen(6, 'Y')],
      [nav(APP, 2), nav(2, 3), nav(3, 4), nav(4, 2), nav(4, APP), nav(5, 6), nav(6, 5)], // X and Y cycle apart
    );
    const depth = Object.fromEntries(summarizeGraph(graph).keyScreens.map((k) => [k.screen.name, k.depth]));
    assert.deepEqual(depth, { A: 1, B: 2, C: 3, X: null, Y: null });
  });

  it('App (OnStart) without navigations: every depth is null, the order is connections, name, id', () => {
    const graph = graphOf(
      [screen(2, 'B'), screen(3, 'A'), screen(4, 'C'), variable(10, 'g')],
      [nav(2, 3), access(4, 'variable:10'), access(4, 'variable:10')],
    );
    const result = summarizeGraph(graph).keyScreens;
    assert.deepEqual(
      result.map((k) => [k.screen.name, k.depth, k.connections]),
      [
        ['A', null, 1],
        ['B', null, 1],
        ['C', null, 1],
      ],
    );
  });

  it('carries the status and the Miro link of each screen', () => {
    const graph = graphOf([screen(2, 'Home', { status: 'IN_REVIEW', miro: 'https://miro.com/x' })], [nav(APP, 2)]);
    assert.deepEqual(summarizeGraph(graph).keyScreens[0], {
      screen: { id: 2, name: 'Home' },
      documentationStatus: 'IN_REVIEW',
      connections: 1,
      depth: 1,
      miroLink: 'https://miro.com/x',
    });
  });
});

describe('onboarding: an application with little or nothing', () => {
  it('an empty application (only App (OnStart)) has empty lists and the App screen', () => {
    const parts = summarizeGraph(graphOf([]));
    assert.deepEqual(parts.keyScreens, []);
    assert.deepEqual(parts.globalVariables, []);
    assert.deepEqual(parts.topComponents, []);
    assert.equal(parts.componentCount, 0);
    assert.deepEqual(parts.appContext, {
      id: APP,
      name: 'App (OnStart)',
      documentationStatus: 'APPROVED',
      miroLink: null,
    });
  });

  it('fewer than 10 elements: lists as long as the elements, not padded', () => {
    const graph = graphOf(
      [screen(2, 'A'), screen(3, 'B'), variable(10, 'g'), component(30, 'c', 2)],
      [uses(30, 'variable:10')],
    );
    const parts = summarizeGraph(graph);
    assert.equal(parts.keyScreens.length, 2);
    assert.equal(parts.globalVariables.length, 1);
    assert.equal(parts.topComponents.length, 1);
  });

  it('a graph without App (OnStart) is an invariant violation', () => {
    assert.throws(() => summarizeGraph({ nodes: [screen(2, 'A')], edges: [] }), /no App \(OnStart\) screen/);
  });
});

describe('onboarding: global variables (D-124)', () => {
  it('lists only GLOBAL variables, by distinct reading or writing screens, then name, then id', () => {
    const graph = graphOf(
      [
        screen(2, 'S1'),
        screen(3, 'S2'),
        screen(4, 'S3'),
        variable(10, 'gMost'), // 3 screens
        variable(11, 'gB'), // 1 screen
        variable(12, 'gA'), // 1 screen: before gB by name
        variable(13, 'gA'), // 1 screen, same name as 12: the id decides
        variable(14, 'cCtx', 'CONTEXT'), // CONTEXT: never listed
        variable(15, 'gUnused'), // 0 screens: listed last
        variable(16, 'gOriginOnly'), // created by a screen, never read: 0
      ],
      [
        access(2, 'variable:10'),
        access(3, 'variable:10'),
        access(4, 'variable:10'),
        access(4, 'variable:10'), // same screen twice: still one screen
        access(2, 'variable:11'),
        access(2, 'variable:12'),
        access(3, 'variable:13'),
        access(2, 'variable:14'),
        edge('CREATES', 'screen:2', 'variable:16'),
      ],
    );
    assert.deepEqual(
      summarizeGraph(graph).globalVariables.map((v) => [v.variable.id, v.usedByScreens]),
      [
        [10, 3],
        [12, 1],
        [13, 1],
        [11, 1],
        [16, 0],
        [15, 0],
      ],
    );
  });

  it('CREATES is not a use, and the origin screen is the CREATES source (null without one)', () => {
    const graph = graphOf(
      [screen(2, 'Maker'), screen(3, 'Reader'), variable(10, 'gMade'), variable(11, 'gLoose')],
      [edge('CREATES', 'screen:2', 'variable:10'), access(3, 'variable:10')],
    );
    assert.deepEqual(summarizeGraph(graph).globalVariables, [
      { variable: { id: 10, name: 'gMade' }, originScreen: { id: 2, name: 'Maker' }, usedByScreens: 1 },
      { variable: { id: 11, name: 'gLoose' }, originScreen: null, usedByScreens: 0 },
    ]);
  });

  it('keeps 10 of 12 and orders names by code point', () => {
    const names = ['gb', 'gB', 'ga', 'gA', 'g1', 'g_', 'gz', 'gZ', 'gñ', 'gÑ', 'g0', 'g9'];
    const graph = graphOf(names.map((name, index) => variable(100 + index, name)));
    const listed = summarizeGraph(graph).globalVariables.map((v) => v.variable.name);
    // by code point: 0 1 9 (digits), A B Z, _ , a b z, then Ñ and ñ: the last two are cut
    assert.deepEqual(listed, ['g0', 'g1', 'g9', 'gA', 'gB', 'gZ', 'g_', 'ga', 'gb', 'gz']);
  });
});

describe('onboarding: top components (D-50, D-124)', () => {
  it('lists only components that use at least one element, by uses, then component name, screen name and id', () => {
    const graph = graphOf(
      [
        screen(2, 'Zeta'),
        screen(3, 'Alfa'),
        variable(10, 'gA'),
        variable(11, 'gB'),
        collection(20, 'colA'),
        component(30, 'gal', 2), // 3 uses
        component(31, 'btn', 2), // 1 use
        component(32, 'btn', 3), // 1 use, same name, screen Alfa < Zeta
        component(33, 'btn', 3), // 1 use, same name and screen as 32: the id decides
        component(34, 'idle', 2), // 0 uses: not listed
        component(35, 'Upper', 2), // 1 use: uppercase before lowercase
      ],
      [
        uses(30, 'variable:10'),
        uses(30, 'variable:11'),
        uses(30, 'collection:20'),
        uses(31, 'variable:10'),
        uses(32, 'variable:10'),
        uses(33, 'variable:10'),
        uses(35, 'variable:10'),
        edge('CONTAINS', 'screen:2', 'component:34'),
      ],
    );
    const result = summarizeGraph(graph).topComponents;
    assert.deepEqual(
      result.map((c) => [c.component.id, c.screen.name, c.uses]),
      [
        [30, 'Zeta', 3],
        [35, 'Zeta', 1],
        [32, 'Alfa', 1],
        [33, 'Alfa', 1],
        [31, 'Zeta', 1],
      ],
    );
    assert.equal(summarizeGraph(graph).componentCount, 6);
  });

  it('keeps 10 of 12 components with uses', () => {
    const nodes: GraphNode[] = [screen(2, 'S'), variable(10, 'g')];
    const edges: GraphEdge[] = [];
    for (let i = 0; i < 12; i += 1) {
      nodes.push(component(30 + i, `c${String(i).padStart(2, '0')}`, 2));
      edges.push(uses(30 + i, 'variable:10'));
    }
    const listed = summarizeGraph(graphOf(nodes, edges)).topComponents.map((c) => c.component.name);
    assert.equal(listed.length, 10);
    assert.deepEqual(listed, ['c00', 'c01', 'c02', 'c03', 'c04', 'c05', 'c06', 'c07', 'c08', 'c09']);
  });
});
