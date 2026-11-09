/**
 * Module 7, the indicators (FR-19; D-106): exact figures on disposable data, for the three roles, with every 200
 * checked against the contract. Jira is never called (the Jira client is the application's own, without a simulator).
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { assertConformsToContract } from '../helpers/contractResponse.js';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { getIndicators, indicatorsOk, indicatorsOf } from '../helpers/dashboard.js';
import {
  deleteScreen,
  insertApplication,
  insertCollection,
  insertScreen,
  insertScreenCollection,
  insertVariable,
  setApplicationStatus,
} from '../helpers/fixtures.js';
import { watchPgOverlap } from '../helpers/pgWarnings.js';

type Status = 'UNDOCUMENTED' | 'DRAFT' | 'IN_PROGRESS' | 'IN_REVIEW' | 'APPROVED';

describe('dashboard: the indicators', () => {
  let t: TestApp;
  const pgOverlap = watchPgOverlap();

  before(async () => {
    t = await startTestApp();
  });
  after(async () => {
    pgOverlap.stop();
    await t.close();
  });

  const tokens = () => ({
    administrator: t.users.admin.token,
    developer: t.users.developer.token,
    reader: t.users.reader.token,
  });

  /** An application with `count` screens in each given status (plus App (OnStart), UNDOCUMENTED). */
  const withScreens = async (statuses: readonly Status[]) => {
    const application = await insertApplication(t);
    for (const documentationStatus of statuses) await insertScreen(t, application.id, { documentationStatus });
    return application;
  };

  describe('documentation', () => {
    it('the five statuses plus App (OnStart): exact figures, byStatus adds up to totalScreens', async () => {
      const app = await withScreens([
        'UNDOCUMENTED',
        'DRAFT',
        'DRAFT',
        'IN_PROGRESS',
        'IN_PROGRESS',
        'IN_PROGRESS',
        'IN_REVIEW',
        'APPROVED',
        'APPROVED',
        'APPROVED',
        'APPROVED',
      ]);
      for (const token of Object.values(tokens())) {
        const { documentation } = await indicatorsOk(t, app.id, token);
        // App (OnStart) is UNDOCUMENTED: 1 + 1.
        assert.deepEqual(documentation.byStatus, {
          UNDOCUMENTED: 2,
          DRAFT: 2,
          IN_PROGRESS: 3,
          IN_REVIEW: 1,
          APPROVED: 4,
        });
        assert.equal(documentation.totalScreens, 12);
        assert.equal(
          Object.values(documentation.byStatus).reduce((a, b) => a + b, 0),
          12,
        );
        assert.equal(documentation.approvedPercent, 33.3);
      }
    });

    it('an application with only App (OnStart): every status is there, 0 except its own', async () => {
      const app = await insertApplication(t);
      const { documentation } = await indicatorsOk(t, app.id);
      assert.deepEqual(documentation.byStatus, {
        UNDOCUMENTED: 1,
        DRAFT: 0,
        IN_PROGRESS: 0,
        IN_REVIEW: 0,
        APPROVED: 0,
      });
      assert.equal(documentation.totalScreens, 1);
      assert.equal(documentation.approvedPercent, 0);
    });

    it('App (OnStart) approved: 1 of 1 is 100', async () => {
      const app = await insertApplication(t);
      await t.owner.query(`UPDATE screen SET documentation_status = 'APPROVED' WHERE id = $1`, [
        app.appContextScreenId,
      ]);
      const { documentation } = await indicatorsOk(t, app.id);
      assert.equal(documentation.approvedPercent, 100);
      assert.equal(documentation.byStatus.APPROVED, 1);
    });

    it('the percent is rounded half up to one decimal (1 of 16 is 6.3, 3 of 16 is 18.8, 1 of 8 is 12.5)', async () => {
      // 15 screens + App (OnStart) = 16 in total.
      const one = await withScreens(['APPROVED', ...Array<Status>(14).fill('DRAFT')]);
      assert.equal((await indicatorsOk(t, one.id)).documentation.totalScreens, 16);
      assert.equal((await indicatorsOk(t, one.id)).documentation.approvedPercent, 6.3);
      const three = await withScreens(['APPROVED', 'APPROVED', 'APPROVED', ...Array<Status>(12).fill('DRAFT')]);
      assert.equal((await indicatorsOk(t, three.id)).documentation.approvedPercent, 18.8);
      const eighth = await withScreens(['APPROVED', ...Array<Status>(6).fill('DRAFT')]);
      assert.equal((await indicatorsOk(t, eighth.id)).documentation.approvedPercent, 12.5);
    });

    it('in practice the total is never 0: every application has its App (OnStart) screen', async () => {
      const r = await t.owner.query<{ missing: number }>(
        `SELECT count(*)::int AS missing FROM application a
          WHERE NOT EXISTS (SELECT 1 FROM screen s WHERE s.application_id = a.id AND s.is_app_context)`,
      );
      assert.equal(r.rows[0]!.missing, 0);
    });
  });

  describe('variables and collections', () => {
    it('untraced counts the variables without an origin screen, also the one that lost it with its screen', async () => {
      const app = await insertApplication(t);
      const origin = await insertScreen(t, app.id);
      const lost = await insertScreen(t, app.id);
      await insertVariable(t, app.id, { name: 'gNoOrigin' });
      await insertVariable(t, app.id, { name: 'gWithOrigin', scope: 'CONTEXT', originScreenId: origin.id });
      await insertVariable(t, app.id, { name: 'gLost', scope: 'GLOBAL', originScreenId: lost.id });
      let data = await indicatorsOk(t, app.id);
      assert.deepEqual(data.variables, { total: 3, untraced: 1 });
      await deleteScreen(t, lost.id);
      data = await indicatorsOk(t, app.id);
      assert.deepEqual(data.variables, { total: 3, untraced: 2 });
    });

    it('undocumented counts the collections linked to no screen; total counts all of them', async () => {
      const app = await insertApplication(t);
      const screen = await insertScreen(t, app.id);
      const linked = await insertCollection(t, app.id, { name: 'colLinked' });
      await insertCollection(t, app.id, { name: 'colFree1' });
      await insertCollection(t, app.id, { name: 'colFree2' });
      await insertScreenCollection(t, {
        screenId: screen.id,
        collectionId: linked.id,
        accessMode: 'READ',
        usedIn: 'a',
      });
      await insertScreenCollection(t, {
        screenId: screen.id,
        collectionId: linked.id,
        accessMode: 'WRITE',
        usedIn: 'b',
      });
      assert.deepEqual((await indicatorsOk(t, app.id)).collections, { total: 3, undocumented: 2 });
      await deleteScreen(t, screen.id);
      assert.deepEqual((await indicatorsOk(t, app.id)).collections, { total: 3, undocumented: 3 });
    });

    it('an empty application has 0 of everything', async () => {
      const app = await insertApplication(t);
      const data = await indicatorsOk(t, app.id);
      assert.deepEqual(data.variables, { total: 0, untraced: 0 });
      assert.deepEqual(data.collections, { total: 0, undocumented: 0 });
    });
  });

  describe('two applications', () => {
    it('no figure leaks from one to the other', async () => {
      const a = await insertApplication(t);
      const b = await insertApplication(t);
      await insertScreen(t, a.id, { documentationStatus: 'APPROVED' });
      await insertVariable(t, a.id, { name: 'gOnlyA' });
      await insertCollection(t, a.id, { name: 'colOnlyA' });
      await insertScreen(t, b.id, { documentationStatus: 'DRAFT' });
      await insertScreen(t, b.id, { documentationStatus: 'DRAFT' });
      const dataA = await indicatorsOk(t, a.id);
      const dataB = await indicatorsOk(t, b.id);
      assert.equal(dataA.documentation.totalScreens, 2);
      assert.equal(dataA.documentation.byStatus.APPROVED, 1);
      assert.deepEqual(dataA.variables, { total: 1, untraced: 1 });
      assert.deepEqual(dataA.collections, { total: 1, undocumented: 1 });
      assert.equal(dataB.documentation.totalScreens, 3);
      assert.equal(dataB.documentation.byStatus.APPROVED, 0);
      assert.deepEqual(dataB.variables, { total: 0, untraced: 0 });
      assert.deepEqual(dataB.collections, { total: 0, undocumented: 0 });
    });
  });

  describe('archived application', () => {
    it('is read like any other', async () => {
      const app = await withScreens(['APPROVED', 'DRAFT']);
      await setApplicationStatus(t, app.id, 'ARCHIVED');
      for (const token of Object.values(tokens())) {
        const { documentation } = await indicatorsOk(t, app.id, token);
        assert.equal(documentation.totalScreens, 3);
      }
    });
  });

  describe('errors', () => {
    it('401 without a token', async () => {
      const res = await t.http.get('/api/v1/dashboard/indicators?applicationId=1');
      assert.equal(res.status, 401);
      assert.equal(bodyOf(res).code, 'UNAUTHENTICATED');
    });

    it('400 without applicationId, or with one that is not a whole number', async () => {
      for (const path of ['/dashboard/indicators', '/dashboard/indicators?applicationId=abc']) {
        const r = await t.http.get(`/api/v1${path}`).set('Authorization', `Bearer ${t.users.admin.token}`);
        assert.equal(r.status, 400, path);
        assert.equal(bodyOf(r).code, 'VALIDATION_ERROR');
      }
    });

    it('404 for an application that does not exist, and for an id beyond the integer range', async () => {
      for (const id of [999999, 2147483647, 2147483648, 99999999999]) {
        const res = await getIndicators(t, id);
        assert.equal(res.status, 404, String(id));
        assert.equal(bodyOf(res).code, 'NOT_FOUND');
        await assertConformsToContract(res);
      }
    });

    it('the order is 400 before 404', async () => {
      const res = await t.http
        .get('/api/v1/dashboard/indicators?applicationId=0')
        .set('Authorization', `Bearer ${t.users.admin.token}`);
      assert.equal(res.status, 400);
    });

    it('a deactivated user is 401', async () => {
      const res = await getIndicators(t, 1, t.users.inactive.token);
      assert.equal(res.status, 401);
    });
  });

  describe('ETag and 304', () => {
    it('every 200 has an ETag, and If-None-Match with it answers 304 without a body', async () => {
      const app = await withScreens(['DRAFT']);
      const first = await getIndicators(t, app.id);
      assert.equal(first.status, 200);
      const etag = first.headers['etag'] as string;
      assert.match(etag, /^W\/"/);
      const again = await getIndicators(t, app.id);
      assert.equal(again.headers['etag'], etag, 'the same data gives the same ETag');
      const cached = await getIndicators(t, app.id).set('If-None-Match', etag);
      assert.equal(cached.status, 304);
      assert.deepEqual(cached.body, {});
    });

    it('a change in the figures changes the ETag', async () => {
      const app = await withScreens(['DRAFT']);
      const etag = (await getIndicators(t, app.id)).headers['etag'] as string;
      await insertScreen(t, app.id, { documentationStatus: 'APPROVED' });
      const changed = await getIndicators(t, app.id).set('If-None-Match', etag);
      assert.equal(changed.status, 200);
      assert.notEqual(changed.headers['etag'], etag);
    });

    it('the Reader and the Administrator have different bodies, so different ETags', async () => {
      const app = await withScreens(['DRAFT']);
      const admin = await getIndicators(t, app.id);
      const reader = await getIndicators(t, app.id, t.users.reader.token);
      assert.notEqual(admin.headers['etag'], reader.headers['etag']);
      assert.equal(indicatorsOf(reader).recentActivity, undefined);
    });
  });
});
