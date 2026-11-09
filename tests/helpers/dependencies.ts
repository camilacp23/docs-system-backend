/**
 * Helpers of the dependency-map tests: the shape of the responses and the data set of
 * `tests/09_dependency_graph_tests.sql`, built with the fixtures on the disposable database of `startTestApp`.
 */
import assert from 'node:assert/strict';
import {
  insertApplication,
  insertCollection,
  insertComponent,
  insertDependency,
  insertScreen,
  insertScreenCollection,
  insertScreenVariable,
  insertVariable,
  insertVariableCollection,
  type FixtureContext,
} from './fixtures.js';

/** A node or an edge as the API returns it; the tests read only a few keys. */
export type NodeBody = { key: string; id: number; type: string; name: string } & Record<string, unknown>;
export type EdgeBody = { id: string; source: string; target: string; kind: string } & Record<string, unknown>;
export type GraphBody = { nodes: NodeBody[]; edges: EdgeBody[] };

/** Typed view of a graph response. */
export const graphOf = (res: { body: unknown }): GraphBody => (res.body as { data: GraphBody }).data;

/** `type:id` of an element. */
export const keyOf = (type: 'screen' | 'variable' | 'collection' | 'component', id: number): string => `${type}:${id}`;

/** Asserts the invariant of the graph: every edge points to two nodes of the same response, and nothing repeats. */
export function assertNoDanglingEdges(graph: GraphBody): void {
  const keys = new Set(graph.nodes.map((n) => n.key));
  assert.equal(keys.size, graph.nodes.length, 'a node appears twice');
  assert.equal(new Set(graph.edges.map((e) => e.id)).size, graph.edges.length, 'an edge appears twice');
  for (const e of graph.edges) {
    assert.ok(keys.has(e.source), `edge ${e.id} starts at ${e.source}, which is not in the response`);
    assert.ok(keys.has(e.target), `edge ${e.id} ends at ${e.target}, which is not in the response`);
  }
}

/** Count of edges by kind, as `KIND=n` pairs sorted by kind (the format of test 09). */
export const edgeKinds = (graph: GraphBody): string =>
  Object.entries(
    graph.edges.reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.kind]: (acc[e.kind] ?? 0) + 1 }), {}),
  )
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([kind, n]) => `${kind}=${n}`)
    .join(', ');

/** The data set of test 09 (application "SAR"), plus the other application "OTRA". */
export type SarFixture = {
  sar: { id: number; appScreen: number };
  otra: { id: number; appScreen: number; inicio: number; gOtra: number };
  solicitudes: number;
  detalle: number;
  gUsuario: number;
  locFiltro: number;
  colSolicitudes: number;
  colActivas: number;
  btnFiltrar: number;
  galSolicitudes: number;
  /** Row ids of the links and dependencies, by the edge id prefix they produce. */
  rows: { sv: number; sc: number; vc: number; usesBtn: number; usesGal: number; derives: number; navigates: number };
};

/**
 * Builds the data of `tests/09_dependency_graph_tests.sql`: 9 nodes and 11 edges in SAR (2 per CONTAINS, CREATES,
 * ACCESSES and USES; 1 per FEEDS, DERIVES_FROM and NAVIGATES_TO), and 3 nodes and 1 edge in OTRA.
 * Environments: `gUsuario` DEV and PROD, `locFiltro` DEV, `colSolicitudes` DEV, `colActivas` PROD.
 *
 * @param t - Test context (owner connection and administrator).
 */
export async function seedSar(t: FixtureContext): Promise<SarFixture> {
  const sar = await insertApplication(t, { name: 'SAR' });
  const otra = await insertApplication(t, { name: 'OTRA' });
  const solicitudes = await insertScreen(t, sar.id, { name: 'Solicitudes' });
  const detalle = await insertScreen(t, sar.id, { name: 'Detalle' });
  const inicio = await insertScreen(t, otra.id, { name: 'Inicio' });
  const gUsuario = await insertVariable(t, sar.id, {
    name: 'gUsuario',
    dataType: 'RECORD',
    originScreenId: sar.appContextScreenId,
    environments: [{ environment: 'DEV' }, { environment: 'PROD' }],
  });
  const locFiltro = await insertVariable(t, sar.id, {
    name: 'locFiltro',
    scope: 'CONTEXT',
    originScreenId: solicitudes.id,
  });
  const gOtra = await insertVariable(t, otra.id, { name: 'gOtra', originScreenId: inicio.id });
  const colSolicitudes = await insertCollection(t, sar.id, { name: 'colSolicitudes' });
  const colActivas = await insertCollection(t, sar.id, { name: 'colActivas', environments: [{ environment: 'PROD' }] });
  const btnFiltrar = await insertComponent(t, sar.id, solicitudes.id, { name: 'btnFiltrar' });
  const galSolicitudes = await insertComponent(t, sar.id, solicitudes.id, { name: 'galSolicitudes', type: 'Gallery' });
  const rows = {
    sv: await insertScreenVariable(t, {
      screenId: solicitudes.id,
      variableId: locFiltro.id,
      accessMode: 'READ',
      usedIn: 'galSolicitudes.Items',
    }),
    sc: await insertScreenCollection(t, {
      screenId: solicitudes.id,
      collectionId: colSolicitudes.id,
      accessMode: 'READ',
      usedIn: 'galSolicitudes.Items',
    }),
    vc: await insertVariableCollection(t, {
      variableId: gUsuario.id,
      collectionId: colSolicitudes.id,
      screenId: sar.appContextScreenId,
      usedIn: 'OnStart',
      assignmentFunction: 'SET',
      tableFunction: 'First',
    }),
    usesBtn: await insertDependency(t, { sourceId: btnFiltrar.id, targetId: locFiltro.id, relationType: 'USES' }),
    usesGal: await insertDependency(t, {
      sourceId: galSolicitudes.id,
      targetId: colSolicitudes.id,
      relationType: 'USES',
    }),
    derives: await insertDependency(t, {
      sourceId: colActivas.id,
      targetId: colSolicitudes.id,
      relationType: 'DERIVES_FROM',
    }),
    navigates: await insertDependency(t, {
      sourceId: solicitudes.id,
      targetId: detalle.id,
      relationType: 'NAVIGATES_TO',
    }),
  };
  return {
    sar: { id: sar.id, appScreen: sar.appContextScreenId },
    otra: { id: otra.id, appScreen: otra.appContextScreenId, inicio: inicio.id, gOtra: gOtra.id },
    solicitudes: solicitudes.id,
    detalle: detalle.id,
    gUsuario: gUsuario.id,
    locFiltro: locFiltro.id,
    colSolicitudes: colSolicitudes.id,
    colActivas: colActivas.id,
    btnFiltrar: btnFiltrar.id,
    galSolicitudes: galSolicitudes.id,
    rows,
  };
}
