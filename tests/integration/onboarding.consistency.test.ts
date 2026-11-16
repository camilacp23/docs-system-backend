/**
 * Module 11, one snapshot and the same definitions as the dashboard and the map (FR-25; D-124).
 *
 * - The repository takes an optional callback that production never passes. Here it commits changes with the owner
 *   connection right after the application was read and before the figures, the graph, the template and the data
 *   types are, and the summary must show none of them (it is one `REPEATABLE READ` snapshot).
 * - The numbers must be those of `indicatorsOn` and `graphOn` read on the SAME transaction, and the connections and
 *   depths must match an independent computation over that graph.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Prisma } from '../../src/generated/prisma/client.js';
import { createDashboardModuleService } from '../../src/modules/dashboard/routes.js';
import { createDependenciesModuleService } from '../../src/modules/dependencies/routes.js';
import { createOnboardingModuleService } from '../../src/modules/onboarding/routes.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { insertComponent, insertDependency, insertScreen, insertVariable } from '../helpers/fixtures.js';
import { seedStory, summaryOk, type Story } from '../helpers/onboarding.js';
import { oracleScreens } from '../helpers/onboardingOracle.js';
import { watchPgOverlap } from '../helpers/pgWarnings.js';

describe('onboarding: one snapshot, the same definitions', () => {
  let t: TestApp;
  let story: Story;
  const pgOverlap = watchPgOverlap();
  const jira = { jiraAvailable: true };

  before(async () => {
    t = await startTestApp();
    try {
      story = await seedStory(t);
    } catch (error) {
      await t.close();
      throw error;
    }
  });
  after(async () => {
    pgOverlap.stop();
    await t.close();
  });

  const plain = () => createOnboardingModuleService(t.db, { jira });

  describe('a change committed in the middle of the read is not in it', () => {
    it('neither the figures, the graph, the template nor the data types see it; the next read does', async () => {
      const app = await seedStory(t, 'Snapshot story');
      const before = await plain().summary(app.app.id);

      let done = false;
      const late: { screenId: number; variableId: number } = { screenId: 0, variableId: 0 };
      const racing = createOnboardingModuleService(
        t.db,
        { jira },
        {
          afterApplication: async () => {
            if (done) return;
            done = true;
            // A new approved screen that App (OnStart) navigates to, a new global variable used by a new component, a new
            // template text and another data type for gUser, each committed on its own connection.
            const screen = await insertScreen(t, app.app.id, { name: 'Late', documentationStatus: 'APPROVED' });
            await insertDependency(t, {
              sourceId: app.app.appContextScreenId,
              targetId: screen.id,
              relationType: 'NAVIGATES_TO',
            });
            const variable = await insertVariable(t, app.app.id, { name: 'gLate', dataType: 'DATE' });
            const component = await insertComponent(t, app.app.id, screen.id, { name: 'cmpLate' });
            await insertDependency(t, { sourceId: component.id, targetId: variable.id, relationType: 'USES' });
            await t.owner.query(`UPDATE screen SET on_start = 'Changed in the middle.' WHERE id = $1`, [
              app.app.appContextScreenId,
            ]);
            await t.owner.query(`UPDATE variable SET data_type = 'DATE' WHERE id = $1`, [app.gUser.id]);
            late.screenId = screen.id;
            late.variableId = variable.id;
          },
        },
      ).summary(app.app.id);

      const during = await racing;
      assert.notEqual(late.screenId, 0, 'the changes were committed in the middle of the read');
      assert.deepEqual(during, before, 'the whole body is the snapshot');

      const next = await plain().summary(app.app.id);
      assert.equal(next.counts.screens, before.counts.screens + 1);
      assert.equal(next.counts.variables, before.counts.variables + 1);
      assert.equal(next.counts.components, before.counts.components + 1);
      assert.equal(next.appContextScreen.template.onStart, 'Changed in the middle.');
      assert.equal(next.globalVariables.find((v) => v.variable.id === app.gUser.id)?.dataType, 'DATE');
      assert.ok(next.globalVariables.some((v) => v.variable.id === late.variableId));
      assert.ok(next.keyScreens.some((k) => k.screen.id === late.screenId && k.depth === 1));
    });

    it('reads at the same time give the same body', async () => {
      const app = await seedStory(t, 'Parallel story');
      const first = await plain().summary(app.app.id);
      const results = await Promise.all([plain().summary(app.app.id), plain().summary(app.app.id)]);
      assert.deepEqual(results, [first, first]);
    });
  });

  describe('it is what the dashboard and the map say on the same transaction', () => {
    it('the counts, the percentage and the components are those of indicatorsOn and graphOn', async () => {
      const dashboard = createDashboardModuleService(t.db, { jira });
      const dependencies = createDependenciesModuleService(t.db);
      const { indicators, graph } = await t.db.base.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          return {
            indicators: await dashboard.indicatorsOn(tx, story.app.id),
            graph: await dependencies.graphOn(tx, story.app.id),
          };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
      const summary = await summaryOk(t, story.app.id);
      assert.equal(summary.counts.screens, indicators.documentation.totalScreens);
      assert.equal(summary.counts.variables, indicators.variables.total);
      assert.equal(summary.counts.collections, indicators.collections.total);
      assert.equal(summary.counts.components, graph.nodes.filter((n) => n.type === 'COMPONENT').length);
      assert.equal(summary.approvedPercent, indicators.documentation.approvedPercent);
      assert.equal(summary.counts.screens, graph.nodes.filter((n) => n.type === 'SCREEN').length);
      assert.equal(summary.counts.variables, graph.nodes.filter((n) => n.type === 'VARIABLE').length);
      assert.equal(summary.counts.collections, graph.nodes.filter((n) => n.type === 'COLLECTION').length);
    });

    it('the connections and the depths match an independent computation over the map graph', async () => {
      const dependencies = createDependenciesModuleService(t.db);
      const graph = await t.db.base.$transaction((tx) => dependencies.graphOn(tx, story.app.id), {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });
      const truth = oracleScreens(graph);
      const { keyScreens } = await summaryOk(t, story.app.id);
      assert.equal(keyScreens.length, truth.size, 'fewer than 10 screens: all of them');
      for (const key of keyScreens) {
        assert.deepEqual({ connections: key.connections, depth: key.depth }, truth.get(key.screen.id), key.screen.name);
      }
    });

    it('the graph endpoint of the map gives the same graph the summary was derived from', async () => {
      const res = await t.http
        .get(`/api/v1/dependencies/graph?applicationId=${story.app.id}`)
        .set('Authorization', `Bearer ${t.users.admin.token}`);
      const edges = (res.body as { data: { edges: { kind: string; source: string; target: string }[] } }).data.edges;
      const navigations = edges.filter((e) => e.kind === 'NAVIGATES_TO').length;
      assert.equal(navigations, 5, 'the cycle and the unreachable link of the story are in the map as in the summary');
      const { keyScreens } = await summaryOk(t, story.app.id);
      assert.deepEqual(
        keyScreens.map((k) => k.depth),
        [1, 2, 3, null, null],
      );
    });
  });
});
