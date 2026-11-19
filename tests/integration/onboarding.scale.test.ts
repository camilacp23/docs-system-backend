/**
 * Module 11, department scale (NFR-11): one application of about 500 nodes (all node and edge kinds, cycles of
 * navigation included, like `npm run sandbox:graph`). The test reads the summary and prints its median and maximum time
 * next to those of the graph it is derived from. It asserts NO time (a threshold would be flaky on a 2-CPU runner); it
 * asserts the size, the limits, the contract and the key screens against an independent computation.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { assertConformsToContract } from '../helpers/contractResponse.js';
import { graphOf } from '../helpers/dependencies.js';
import {
  insertApplication,
  insertCollection,
  insertComponent,
  insertDependency,
  insertScreen,
  insertScreenCollection,
  insertScreenVariable,
  insertVariable,
} from '../helpers/fixtures.js';
import { getSummary, summaryOf } from '../helpers/onboarding.js';
import { oracleScreens } from '../helpers/onboardingOracle.js';
import { asUser } from '../helpers/users.js';

const SCREENS = 39; // plus App (OnStart): 40
const VARIABLES = 120;
const COLLECTIONS = 60;
const COMPONENTS = 280;
const READS = 15;

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

describe('onboarding: about 500 nodes', () => {
  let t: TestApp;
  let applicationId: number;

  before(async () => {
    t = await startTestApp();
    try {
      const app = await insertApplication(t, { name: 'Onboarding scale app' });
      applicationId = app.id;
      const screenIds = [app.appContextScreenId];
      for (let i = 0; i < SCREENS; i += 1) {
        const status = i % 3 === 0 ? 'APPROVED' : 'DRAFT';
        screenIds.push((await insertScreen(t, app.id, { name: `scr${i}`, documentationStatus: status })).id);
      }
      const variableIds: number[] = [];
      for (let i = 0; i < VARIABLES; i += 1) {
        const origin = i % 6 === 0 ? null : screenIds[i % screenIds.length]!;
        variableIds.push((await insertVariable(t, app.id, { name: `gVar${i}`, originScreenId: origin })).id);
      }
      const collectionIds: number[] = [];
      for (let i = 0; i < COLLECTIONS; i += 1)
        collectionIds.push((await insertCollection(t, app.id, { name: `col${i}` })).id);
      const componentIds: number[] = [];
      for (let i = 0; i < COMPONENTS; i += 1)
        componentIds.push((await insertComponent(t, app.id, screenIds[1 + (i % SCREENS)]!, { name: `cmp${i}` })).id);

      // Each screen reads a different number of variables, so the connections differ and ties are rare but present.
      for (let i = 0; i < screenIds.length; i += 1) {
        for (let j = 0; j < 2 + (i % 5); j += 1) {
          await insertScreenVariable(t, {
            screenId: screenIds[i]!,
            variableId: variableIds[(i * 3 + j) % VARIABLES]!,
            accessMode: 'READ_WRITE',
            usedIn: `Control${j}.Text`,
          });
        }
        for (let j = 0; j < 2; j += 1) {
          await insertScreenCollection(t, {
            screenId: screenIds[i]!,
            collectionId: collectionIds[(i + j) % COLLECTIONS]!,
            accessMode: 'READ',
            usedIn: `Gallery${j}.Items`,
          });
        }
      }
      for (let i = 0; i < COMPONENTS; i += 1) {
        // Some components use one element, some several, some none: the ranking has real ties and real gaps.
        const uses = i % 7 === 0 ? 0 : 1 + (i % 4);
        for (let j = 0; j < uses; j += 1) {
          await insertDependency(t, {
            sourceId: componentIds[i]!,
            targetId: j % 2 === 0 ? variableIds[(i + j) % VARIABLES]! : collectionIds[(i + j) % COLLECTIONS]!,
            relationType: 'USES',
          });
        }
      }
      // Navigation rings: every screen is in a cycle; App (OnStart) reaches only the first ten.
      for (let i = 1; i <= SCREENS; i += 1)
        await insertDependency(t, {
          sourceId: screenIds[i]!,
          targetId: screenIds[(i % SCREENS) + 1]!,
          relationType: 'NAVIGATES_TO',
        });
      await insertDependency(t, { sourceId: screenIds[0]!, targetId: screenIds[1]!, relationType: 'NAVIGATES_TO' });
      await insertDependency(t, { sourceId: screenIds[0]!, targetId: screenIds[20]!, relationType: 'NAVIGATES_TO' });
    } catch (error) {
      await t.close();
      throw error;
    }
  });
  after(async () => {
    await t.close();
  });

  it('serves the summary, checks it, and prints how long it takes next to the graph', async () => {
    const admin = asUser(t, t.users.admin.token);
    const graphPath = `/dependencies/graph?applicationId=${applicationId}`;

    const warm = await getSummary(t, applicationId);
    assert.equal(warm.status, 200, JSON.stringify(warm.body));
    await assertConformsToContract(warm);
    const data = summaryOf(warm);
    const graph = graphOf(await admin.get(graphPath));
    assert.ok(graph.nodes.length >= 500, `${graph.nodes.length} nodes`);

    // Size and limits.
    assert.deepEqual(data.counts, {
      screens: 40,
      variables: VARIABLES,
      collections: COLLECTIONS,
      components: COMPONENTS,
    });
    assert.equal(data.keyScreens.length, 10);
    assert.equal(data.globalVariables.length, 10);
    assert.equal(data.topComponents.length, 10);

    // Key screens against the independent computation: their numbers, their choice and their order.
    const truth = oracleScreens(graph as never);
    for (const key of data.keyScreens) {
      assert.deepEqual({ connections: key.connections, depth: key.depth }, truth.get(key.screen.id), key.screen.name);
    }
    const chosen = new Set(data.keyScreens.map((k) => k.screen.id));
    const weakestChosen = Math.min(...data.keyScreens.map((k) => k.connections));
    for (const [id, other] of truth) {
      if (!chosen.has(id))
        assert.ok(other.connections <= weakestChosen, `screen ${id} has more connections than a chosen one`);
    }
    const inOrder = data.keyScreens.every((k, i, all) => {
      const previous = all[i - 1];
      if (previous === undefined) return true;
      const a = previous.depth ?? Infinity;
      const b = k.depth ?? Infinity;
      return a < b || (a === b && previous.connections >= k.connections);
    });
    assert.ok(inOrder, 'depth ascending (unreachable last), then connections descending');
    assert.ok(data.keyScreens.some((k) => k.depth === null) || data.keyScreens.length === 10);
    const usage = data.globalVariables.map((v) => v.usedByScreens);
    assert.deepEqual(
      usage,
      [...usage].sort((a, b) => b - a),
    );
    const uses = data.topComponents.map((c) => c.uses);
    assert.deepEqual(
      uses,
      [...uses].sort((a, b) => b - a),
    );
    assert.ok(uses.every((n) => n >= 1));

    // Time: printed, never asserted.
    const measure = async (path: string): Promise<number[]> => {
      const times: number[] = [];
      for (let i = 0; i < READS; i += 1) {
        const started = performance.now();
        const res = await admin.get(path);
        times.push(performance.now() - started);
        assert.equal(res.status, 200);
      }
      return times;
    };
    const summaryTimes = await measure(`/onboarding/summary?applicationId=${applicationId}`);
    const graphTimes = await measure(graphPath);
    const ms = (n: number) => n.toFixed(1);
    console.log(
      `onboarding with ${graph.nodes.length} nodes and ${graph.edges.length} edges, ${READS} reads: ` +
        `summary median ${ms(median(summaryTimes))} ms, max ${ms(Math.max(...summaryTimes))} ms, ` +
        `${Buffer.byteLength(JSON.stringify(warm.body))} bytes; ` +
        `graph median ${ms(median(graphTimes))} ms, max ${ms(Math.max(...graphTimes))} ms`,
    );
  });
});
