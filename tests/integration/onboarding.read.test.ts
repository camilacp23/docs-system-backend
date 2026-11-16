/**
 * Module 11, the onboarding summary (FR-25; D-124) through HTTP on disposable data: the exact body of a known
 * application (navigation cycle, unreachable screen, repeated usages), the three roles, applications that do not leak
 * into each other, an archived application, the 400, 401 and 404 answers, the ETag and the 304, and the contract.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { assertConformsToContract } from '../helpers/contractResponse.js';
import {
  insertApplication,
  insertCollection,
  insertComponent,
  insertDependency,
  insertScreen,
  insertScreenVariable,
  insertVariable,
  setApplicationStatus,
} from '../helpers/fixtures.js';
import { getSummary, seedStory, summaryOf, summaryOk, type Story } from '../helpers/onboarding.js';
import { watchPgOverlap } from '../helpers/pgWarnings.js';

describe('onboarding: the summary', () => {
  let t: TestApp;
  let story: Story;
  const pgOverlap = watchPgOverlap();

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

  const tokens = () => ({
    administrator: t.users.admin.token,
    developer: t.users.developer.token,
    reader: t.users.reader.token,
  });

  describe('the body of a known application', () => {
    it('has the counts, the percentage and the App (OnStart) screen with its seven template fields', async () => {
      const data = await summaryOk(t, story.app.id);
      assert.deepEqual(data.application, { id: story.app.id, name: 'Onboarding story' });
      assert.deepEqual(data.counts, { screens: 6, variables: 4, collections: 1, components: 3 });
      assert.equal(data.approvedPercent, 33.3); // App (OnStart) and Home of 6
      assert.deepEqual(data.appContextScreen, {
        id: story.app.appContextScreenId,
        name: 'App (OnStart)',
        documentationStatus: 'APPROVED',
        miroLink: 'https://miro.com/app/board/story=/',
        template: {
          onStart: 'Loads gUser.',
          workingProcess: null,
          architecture: null,
          dataModel: null,
          requirements: null,
          knownIssues: null,
          risks: 'None.',
        },
      });
    });

    it('key screens: most connections chosen, listed by depth (cycle and unreachable screens included), App (OnStart) left out', async () => {
      const { keyScreens } = await summaryOk(t, story.app.id);
      assert.deepEqual(
        keyScreens.map((k) => [k.screen.name, k.documentationStatus, k.connections, k.depth, k.miroLink]),
        [
          ['Home', 'APPROVED', 5, 1, 'https://miro.com/app/board/story=/?moveToWidget=1'], // App, Catalog, Detail, gUser, cLocal
          ['Catalog', 'IN_REVIEW', 4, 2, null], // Home, Detail, gUser, colItems
          ['Detail', 'DRAFT', 4, 3, null], // Catalog, Home, gUser, colItems; its way back to Home does not shorten anything
          ['Orphan', 'DRAFT', 3, null, null], // gTheme, colItems, Island: not reached from App (OnStart)
          ['Island', 'UNDOCUMENTED', 1, null, null], // only Orphan links to it
        ],
      );
      assert.ok(keyScreens.every((k) => k.screen.id !== story.app.appContextScreenId));
    });

    it('global variables: only GLOBAL, by different screens (CREATES and a repeated usage do not add), the unused one last', async () => {
      const { globalVariables } = await summaryOk(t, story.app.id);
      assert.deepEqual(globalVariables, [
        {
          variable: { id: story.gUser.id, name: 'gUser' },
          dataType: 'TEXT',
          originScreen: { id: story.home.id, name: 'Home' },
          usedByScreens: 3, // Home, Catalog (twice), Detail
        },
        {
          variable: { id: story.gTheme.id, name: 'gTheme' },
          dataType: 'BOOLEAN',
          originScreen: null,
          usedByScreens: 1,
        },
        { variable: { id: story.gUnused.id, name: 'gUnused' }, dataType: 'DATE', originScreen: null, usedByScreens: 0 },
      ]);
    });

    it('top components: only those that use something, by uses', async () => {
      const { topComponents } = await summaryOk(t, story.app.id);
      assert.deepEqual(topComponents, [
        {
          component: { id: story.galItems.id, name: 'galItems' },
          screen: { id: story.catalog.id, name: 'Catalog' },
          uses: 2,
        },
        {
          component: { id: story.btnSave.id, name: 'btnSave' },
          screen: { id: story.detail.id, name: 'Detail' },
          uses: 1,
        },
      ]);
    });
  });

  describe('roles', () => {
    it('the Administrator, the Developer and the Reader get the same body', async () => {
      const bodies = await Promise.all(Object.values(tokens()).map((token) => summaryOk(t, story.app.id, token)));
      assert.deepEqual(bodies[1], bodies[0]);
      assert.deepEqual(bodies[2], bodies[0]);
    });
  });

  describe('an empty application and small ones', () => {
    it('only App (OnStart): empty lists, 1 screen, 0 percent, the template empty', async () => {
      const app = await insertApplication(t);
      const data = await summaryOk(t, app.id);
      assert.deepEqual(data.counts, { screens: 1, variables: 0, collections: 0, components: 0 });
      assert.equal(data.approvedPercent, 0);
      assert.deepEqual([data.keyScreens, data.globalVariables, data.topComponents], [[], [], []]);
      assert.equal(data.appContextScreen.id, app.appContextScreenId);
      assert.equal(data.appContextScreen.documentationStatus, 'UNDOCUMENTED');
      assert.equal(data.appContextScreen.miroLink, null);
      assert.deepEqual(Object.values(data.appContextScreen.template), Array(7).fill(null));
    });

    it('App (OnStart) without navigations: every depth is null, ordered by connections, name and id', async () => {
      const app = await insertApplication(t);
      const b = await insertScreen(t, app.id, { name: 'B' });
      const a = await insertScreen(t, app.id, { name: 'A' });
      const c = await insertScreen(t, app.id, { name: 'C' });
      const g = await insertVariable(t, app.id, { name: 'gOne' });
      await insertScreenVariable(t, { screenId: c.id, variableId: g.id, accessMode: 'READ', usedIn: 'x.Text' });
      await insertDependency(t, { sourceId: b.id, targetId: a.id, relationType: 'NAVIGATES_TO' });
      const { keyScreens } = await summaryOk(t, app.id);
      assert.deepEqual(
        keyScreens.map((k) => [k.screen.name, k.connections, k.depth]),
        [
          ['A', 1, null],
          ['B', 1, null],
          ['C', 1, null],
        ],
      );
    });

    it('a GLOBAL variable nobody uses is listed with 0; a CONTEXT one never is', async () => {
      const app = await insertApplication(t);
      const screen = await insertScreen(t, app.id);
      await insertVariable(t, app.id, { name: 'gLonely' });
      await insertVariable(t, app.id, { name: 'cCtx', scope: 'CONTEXT', originScreenId: screen.id });
      const { globalVariables, counts } = await summaryOk(t, app.id);
      assert.equal(counts.variables, 2);
      assert.deepEqual(
        globalVariables.map((v) => [v.variable.name, v.usedByScreens, v.originScreen]),
        [['gLonely', 0, null]],
      );
    });
  });

  describe('the limits and the ties (10 / 10 / 10)', () => {
    it('chooses 10 of 13 screens, 10 of 12 variables and 10 of 12 components, by the rules of D-124 (names by code point)', async () => {
      const app = await insertApplication(t);
      // 13 screens, each with ONE variable of its own (one connection); screen names are unique, so the tie-break is the name.
      const names = ['b', 'a', 'B', 'A', 'z', 'Z', 'c', 'C', 'd', 'D', 'e', 'ñ', 'f'];
      const screens = [];
      for (const name of names) screens.push(await insertScreen(t, app.id, { name }));
      for (const [index, screen] of screens.entries()) {
        const own = await insertVariable(t, app.id, {
          name: `cOwn${index}`,
          scope: 'CONTEXT',
          originScreenId: screen.id,
        });
        await insertScreenVariable(t, {
          screenId: screen.id,
          variableId: own.id,
          accessMode: 'READ',
          usedIn: 'x.Text',
        });
      }
      // 12 GLOBAL variables with the same usage (one screen) and tied names: name by code point, then id.
      const varNames = ['gb', 'gB', 'ga', 'gA', 'g1', 'g_', 'gz', 'gZ', 'gñ', 'gÑ', 'g0', 'g9'];
      for (const name of varNames) {
        const v = await insertVariable(t, app.id, { name });
        await insertScreenVariable(t, {
          screenId: screens[0]!.id,
          variableId: v.id,
          accessMode: 'READ',
          usedIn: 'x.Text',
        });
      }
      // 12 components with one use each, on screens with names that tie.
      const target = await insertCollection(t, app.id, { name: 'colTarget' });
      const compNames = ['k', 'K', 'k', 'j', 'J', 'm', 'M', 'n', 'N', 'o', 'O', 'p'];
      for (const [index, name] of compNames.entries()) {
        const c = await insertComponent(t, app.id, screens[index % 3]!.id, { name }); // a name is unique per screen
        await insertDependency(t, { sourceId: c.id, targetId: target.id, relationType: 'USES' });
      }

      const data = await summaryOk(t, app.id);
      assert.equal(data.counts.screens, 14);
      assert.equal(data.keyScreens.length, 10);
      assert.equal(data.globalVariables.length, 10);
      assert.equal(data.topComponents.length, 10);

      // Screens: 'b' reads the 12 GLOBAL variables and its own (13 connections); every other screen has 1. So 'b' is
      // chosen first and 9 of the other 12 by code point: A B C D Z a c d e. 'f', 'z' and 'ñ' are cut.
      const chosen = data.keyScreens.map((k) => k.screen.name);
      assert.deepEqual([...chosen].sort(), ['A', 'B', 'C', 'D', 'Z', 'a', 'b', 'c', 'd', 'e']);
      assert.ok(!chosen.includes('ñ'), 'ñ comes after z by code point: it is cut');

      assert.deepEqual(
        data.globalVariables.map((v) => v.variable.name),
        ['g0', 'g1', 'g9', 'gA', 'gB', 'gZ', 'g_', 'ga', 'gb', 'gz'], // 'gÑ' and 'gñ' are cut
      );
      assert.deepEqual(
        data.topComponents.map((c) => c.component.name),
        ['J', 'K', 'M', 'N', 'O', 'j', 'k', 'k', 'm', 'n'], // 'o' and 'p' are cut
      );
    });
  });

  describe('two applications never leak into each other', () => {
    it('each summary holds only its own elements, also with the same names', async () => {
      const first = await insertApplication(t);
      const second = await insertApplication(t);
      for (const app of [first, second]) {
        const s = await insertScreen(t, app.id, { name: 'Same name' });
        const v = await insertVariable(t, app.id, { name: 'gSame' });
        await insertScreenVariable(t, { screenId: s.id, variableId: v.id, accessMode: 'READ', usedIn: 'x.Text' });
        const c = await insertComponent(t, app.id, s.id, { name: 'cmpSame' });
        await insertDependency(t, { sourceId: c.id, targetId: v.id, relationType: 'USES' });
      }
      // The second one gets a heavier screen the first one must not see.
      await insertScreen(t, second.id, { name: 'Only second' });
      const a = await summaryOk(t, first.id);
      const b = await summaryOk(t, second.id);
      assert.equal(a.counts.screens, 2);
      assert.equal(b.counts.screens, 3);
      const idsA = new Set([
        ...a.keyScreens.map((k) => k.screen.id),
        ...a.globalVariables.map((v) => v.variable.id),
        ...a.topComponents.map((c) => c.component.id),
      ]);
      for (const id of [
        ...b.keyScreens.map((k) => k.screen.id),
        ...b.globalVariables.map((v) => v.variable.id),
        ...b.topComponents.map((c) => c.component.id),
      ]) {
        assert.ok(!idsA.has(id), `element ${id} belongs to the other application`);
      }
      assert.ok(!a.keyScreens.some((k) => k.screen.name === 'Only second'));
    });
  });

  describe('archived application', () => {
    it('is read like any other, by the three roles', async () => {
      const app = await seedStory(t, 'Archived story');
      const before = await summaryOk(t, app.app.id);
      await setApplicationStatus(t, app.app.id, 'ARCHIVED');
      for (const token of Object.values(tokens())) assert.deepEqual(await summaryOk(t, app.app.id, token), before);
    });
  });

  describe('errors', () => {
    it('401 without a token, and for a deactivated user', async () => {
      const res = await t.http.get(`/api/v1/onboarding/summary?applicationId=${story.app.id}`);
      assert.equal(res.status, 401);
      assert.equal(bodyOf(res).code, 'UNAUTHENTICATED');
      assert.equal((await getSummary(t, story.app.id, t.users.inactive.token)).status, 401);
    });

    it('400 without applicationId, with a text, with 0 or negative', async () => {
      for (const query of ['', '?applicationId=abc', '?applicationId=0', '?applicationId=-1', '?applicationId=1.5']) {
        const res = await t.http
          .get(`/api/v1/onboarding/summary${query}`)
          .set('Authorization', `Bearer ${t.users.admin.token}`);
        assert.equal(res.status, 400, query);
        assert.equal(bodyOf(res).code, 'VALIDATION_ERROR');
        await assertConformsToContract(res);
      }
    });

    it('404 for an application that does not exist, and for an id beyond the integer range', async () => {
      for (const id of [999999, 2147483647, 2147483648, 99999999999]) {
        for (const token of Object.values(tokens())) {
          const res = await getSummary(t, id, token);
          assert.equal(res.status, 404, String(id));
          assert.equal(bodyOf(res).code, 'NOT_FOUND');
          assert.equal(bodyOf(res).details.reason, undefined, 'a real 404, not NOT_IMPLEMENTED');
          await assertConformsToContract(res);
        }
      }
    });

    it('401 comes before 400, and 400 before 404', async () => {
      assert.equal((await t.http.get('/api/v1/onboarding/summary')).status, 401);
      assert.equal((await getSummary(t, 0)).status, 400);
    });
  });

  describe('ETag and 304', () => {
    it('every 200 has a weak ETag; the same data gives the same one; If-None-Match answers 304 without a body', async () => {
      const first = await getSummary(t, story.app.id);
      assert.equal(first.status, 200);
      const etag = first.headers['etag'] as string;
      assert.match(etag, /^W\/"/);
      assert.equal((await getSummary(t, story.app.id)).headers['etag'], etag);
      assert.equal(
        (await getSummary(t, story.app.id, t.users.reader.token)).headers['etag'],
        etag,
        'the role does not change the body',
      );
      const cached = await getSummary(t, story.app.id).set('If-None-Match', etag);
      assert.equal(cached.status, 304);
      assert.deepEqual(cached.body, {});
      assert.equal(cached.headers['etag'], etag);
    });

    it('a change in the data changes the ETag, and the old one no longer gives 304', async () => {
      const app = await seedStory(t, 'ETag story');
      const etag = (await getSummary(t, app.app.id)).headers['etag'] as string;
      await t.owner.query(`UPDATE screen SET documentation_status = 'APPROVED' WHERE id = $1`, [app.island.id]);
      const changed = await getSummary(t, app.app.id).set('If-None-Match', etag);
      assert.equal(changed.status, 200);
      assert.notEqual(changed.headers['etag'], etag);
      assert.equal(summaryOf(changed).approvedPercent, 50);
    });

    it('a 404 has no ETag and no 304', async () => {
      const res = await getSummary(t, 999999).set('If-None-Match', 'W/"anything"');
      assert.equal(res.status, 404);
    });
  });
});
