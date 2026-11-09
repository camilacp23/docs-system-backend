/**
 * Module 5, department scale (NFR-11): one application of about 500 nodes with every kind of edge, cycles included.
 * The test reads the graph and prints how long it takes. It asserts no time threshold (a threshold would make it flaky
 * on a busy machine); it checks the size, the contract and the invariant of the graph.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { assertConformsToContract } from '../helpers/contractResponse.js';
import { assertNoDanglingEdges, edgeKinds, graphOf } from '../helpers/dependencies.js';
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
} from '../helpers/fixtures.js';
import { asUser } from '../helpers/users.js';

const SCREENS = 39; // plus App (OnStart): 40
const VARIABLES = 120;
const COLLECTIONS = 60;
const COMPONENTS = 280;
const READS = 7;

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

describe('dependencies: about 500 nodes', () => {
  let t: TestApp;
  let applicationId: number;
  let screenIds: number[];

  before(async () => {
    t = await startTestApp();
    try {
      const app = await insertApplication(t, { name: 'Performance app' });
      applicationId = app.id;
      screenIds = [app.appContextScreenId];
      for (let i = 0; i < SCREENS; i += 1) screenIds.push((await insertScreen(t, app.id, { name: `scr${i}` })).id);

      const variableIds: number[] = [];
      for (let i = 0; i < VARIABLES; i += 1) {
        // Every sixth variable has no origin (untraced); the rest are created by a screen.
        const origin = i % 6 === 0 ? null : screenIds[i % screenIds.length]!;
        variableIds.push((await insertVariable(t, app.id, { name: `gVar${i}`, originScreenId: origin })).id);
      }
      const collectionIds: number[] = [];
      for (let i = 0; i < COLLECTIONS; i += 1)
        collectionIds.push((await insertCollection(t, app.id, { name: `col${i}` })).id);
      const componentIds: number[] = [];
      for (let i = 0; i < COMPONENTS; i += 1)
        componentIds.push(
          (await insertComponent(t, app.id, screenIds[1 + (i % SCREENS)]!, { name: `cmp${i}`, type: 'Button' })).id,
        );

      // ACCESSES: each screen reads some variables and collections.
      for (let i = 0; i < screenIds.length; i += 1) {
        for (let j = 0; j < 4; j += 1) {
          await insertScreenVariable(t, {
            screenId: screenIds[i]!,
            variableId: variableIds[(i * 3 + j) % VARIABLES]!,
            accessMode: 'READ_WRITE',
            usedIn: `Control${j}.Text`,
          });
          await insertScreenCollection(t, {
            screenId: screenIds[i]!,
            collectionId: collectionIds[(i + j) % COLLECTIONS]!,
            accessMode: 'READ',
            usedIn: `Gallery${j}.Items`,
          });
        }
      }
      // FEEDS: a collection feeds a global variable, assigned on App (OnStart).
      for (let i = 0; i < COLLECTIONS; i += 1) {
        await insertVariableCollection(t, {
          variableId: variableIds[i]!,
          collectionId: collectionIds[i]!,
          screenId: screenIds[0]!,
          usedIn: `OnStart.${i}`,
          assignmentFunction: 'SET',
          tableFunction: i % 2 === 0 ? 'First' : null,
        });
      }
      // USES: components use variables and collections.
      for (let i = 0; i < COMPONENTS; i += 1) {
        const usesVariable = i % 4 !== 0;
        await insertDependency(t, {
          sourceId: componentIds[i]!,
          targetId: usesVariable ? variableIds[i % VARIABLES]! : collectionIds[i % COLLECTIONS]!,
          relationType: 'USES',
        });
      }
      // DERIVES_FROM and NAVIGATES_TO as rings, so every one is part of a cycle.
      for (let i = 0; i < COLLECTIONS; i += 1)
        await insertDependency(t, {
          sourceId: collectionIds[i]!,
          targetId: collectionIds[(i + 1) % COLLECTIONS]!,
          relationType: 'DERIVES_FROM',
        });
      for (let i = 1; i <= SCREENS; i += 1)
        await insertDependency(t, {
          sourceId: screenIds[i]!,
          targetId: screenIds[(i % SCREENS) + 1]!,
          relationType: 'NAVIGATES_TO',
        });
    } catch (error) {
      await t.close();
      throw error;
    }
  });
  after(async () => {
    await t.close();
  });

  it('serves the graph and the neighborhood, and prints how long the graph takes', async () => {
    const admin = asUser(t, t.users.admin.token);
    const path = `/dependencies/graph?applicationId=${applicationId}`;

    const warm = await admin.get(path);
    assert.equal(warm.status, 200);
    await assertConformsToContract(warm);
    const graph = graphOf(warm);
    assertNoDanglingEdges(graph);
    assert.ok(graph.nodes.length >= 500, `${graph.nodes.length} nodes`);

    const times: number[] = [];
    for (let i = 0; i < READS; i += 1) {
      const started = performance.now();
      const res = await admin.get(path);
      times.push(performance.now() - started);
      assert.equal(res.status, 200);
    }
    const bytes = Buffer.byteLength(JSON.stringify(warm.body));
    const ms = (n: number) => n.toFixed(1);

    const started = performance.now();
    const around = await admin.get(`/dependencies/screens/${screenIds[1]}?depth=3`);
    const aroundMs = performance.now() - started;
    assert.equal(around.status, 200);
    await assertConformsToContract(around);
    assertNoDanglingEdges(graphOf(around));

    console.log(
      `[performance] GET /dependencies/graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges ` +
        `(${edgeKinds(graph)}), ${(bytes / 1024).toFixed(0)} KiB; ` +
        `${READS} reads after a warm-up: min ${ms(Math.min(...times))} ms, median ${ms(median(times))} ms, ` +
        `max ${ms(Math.max(...times))} ms. Neighborhood depth 3: ${graphOf(around).nodes.length} nodes in ${ms(aroundMs)} ms.`,
    );
  });
});
