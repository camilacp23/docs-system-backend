/**
 * The reads that the report's Summary and Dependencies parts reuse (D-116): the dashboard figures and the dependency
 * graph read on the client of ANOTHER module's transaction are exactly what `GET /dashboard/indicators` and
 * `GET /dependencies/graph` answer for the same data, so the report cannot drift from the screens that show them.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Prisma } from '../../src/generated/prisma/client.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { getIndicators, indicatorsOf } from '../helpers/dashboard.js';
import {
  insertApplication,
  insertCollection,
  insertDependency,
  insertScreen,
  insertScreenCollection,
  insertVariable,
} from '../helpers/fixtures.js';
import { watchPgOverlap } from '../helpers/pgWarnings.js';
import { asUser } from '../helpers/users.js';
import { createDashboardModuleService } from '../../src/modules/dashboard/routes.js';
import { createDependenciesModuleService } from '../../src/modules/dependencies/routes.js';

describe('reports: reads shared with the dashboard and the dependency map', () => {
  let t: TestApp;
  let applicationId: number;
  const pgOverlap = watchPgOverlap();

  before(async () => {
    t = await startTestApp();
    try {
      applicationId = (await insertApplication(t)).id;
      const a = await insertScreen(t, applicationId, { documentationStatus: 'APPROVED' });
      const b = await insertScreen(t, applicationId, { documentationStatus: 'DRAFT' });
      await insertScreen(t, applicationId, { documentationStatus: 'IN_REVIEW' });
      await insertVariable(t, applicationId, { originScreenId: a.id });
      await insertVariable(t, applicationId, { originScreenId: null });
      const collection = await insertCollection(t, applicationId);
      await insertScreenCollection(t, {
        screenId: a.id,
        collectionId: collection.id,
        accessMode: 'READ',
        usedIn: 'Screen.OnVisible',
      });
      await insertDependency(t, { sourceId: a.id, targetId: b.id, relationType: 'NAVIGATES_TO' });
    } catch (error) {
      await t.close();
      throw error;
    }
  });
  after(async () => {
    pgOverlap.stop();
    await t.close();
  });

  const snapshot = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
    t.db.base.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        return work(tx);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

  it('the dashboard figures read on a transaction of the caller equal GET /dashboard/indicators', async () => {
    const service = createDashboardModuleService(t.db, { jira: t.built.jira });
    const inTransaction = await snapshot((tx) => service.indicatorsOn(tx, applicationId));
    const { recentActivity: _activity, ...endpoint } = indicatorsOf(await getIndicators(t, applicationId));
    assert.deepEqual(inTransaction, endpoint);
    assert.equal(inTransaction.documentation.totalScreens, 4); // three screens and App (OnStart)
  });

  it('the graph read on a transaction of the caller equals GET /dependencies/graph', async () => {
    const service = createDependenciesModuleService(t.db);
    const inTransaction = await snapshot((tx) => service.graphOn(tx, applicationId));
    const res = await asUser(t, t.users.admin.token).get(`/dependencies/graph?applicationId=${applicationId}`);
    assert.equal(res.status, 200);
    assert.deepEqual(inTransaction, (res.body as { data: unknown }).data);
    assert.ok(inTransaction.edges.length > 0);
  });

  it('an application that does not exist is a 404 for both reads', async () => {
    const dashboard = createDashboardModuleService(t.db, { jira: t.built.jira });
    const dependencies = createDependenciesModuleService(t.db);
    await assert.rejects(
      snapshot((tx) => dashboard.indicatorsOn(tx, 2_000_000_000)),
      { code: 'NOT_FOUND' },
    );
    await assert.rejects(
      snapshot((tx) => dependencies.graphOn(tx, 2_000_000_000)),
      { code: 'NOT_FOUND' },
    );
  });
});
