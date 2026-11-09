/**
 * GET /screens (FR-10, FR-14, FR-19; SDD Table 50; D-14, D-70): the only operation of Module 4 implemented so far.
 * Screens, Jira Subtasks and comments are fixtures inserted as docs_owner (the API cannot create them yet).
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { insertApplication, insertComments, insertScreen, insertSubtasks } from '../helpers/fixtures.js';
import { asUser } from '../helpers/users.js';

type ScreenBody = {
  id: number;
  applicationId: number;
  name: string;
  isAppContext: boolean;
  documentationStatus: string;
  author: { id: number; name: string };
  pendingSubtasks: number;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
};
type PageBody = { data: ScreenBody[]; page: number; pageSize: number; total: number };
const pageOf = (res: { body: unknown }): PageBody => res.body as PageBody;
const names = (res: { body: unknown }): string[] => pageOf(res).data.map((s) => s.name);

describe('GET /screens', () => {
  let t: TestApp;
  let app: { id: number; name: string; appContextScreenId: number };
  let other: { id: number; appContextScreenId: number };
  const screens: Record<string, number> = {};

  before(async () => {
    t = await startTestApp();
    app = await insertApplication(t, { name: 'Listing app' });
    other = await insertApplication(t, { name: 'Other app' });
    const make = async (
      name: string,
      over: Parameters<typeof insertScreen>[2] = {},
      subtasks: ('TO_DO' | 'IN_PROGRESS' | 'DONE')[] = [],
    ) => {
      screens[name] = (await insertScreen(t, app.id, { name, ...over })).id;
      if (subtasks.length > 0) await insertSubtasks(t, screens[name], subtasks);
    };
    await make('Alpha', { documentationStatus: 'APPROVED' }, ['DONE', 'DONE']); // 0 pending
    await make('Bravo', { documentationStatus: 'DRAFT', authorId: t.users.developer.id }, ['TO_DO', 'DONE']); // 1
    await make('Charlie', { documentationStatus: 'DRAFT' }, ['TO_DO', 'IN_PROGRESS', 'DONE']); // 2
    await make('Delta', {}, ['IN_PROGRESS', 'IN_PROGRESS']); // 2 (ties with Charlie)
    await make('Echo_100%', {}); // 0
    await insertScreen(t, other.id, { name: 'Foreign' });
    await insertComments(t, screens.Bravo!, 3);
  });
  after(async () => {
    await t.close();
  });

  const get = (query: string, token = t.users.admin.token) =>
    asUser(t, token).get(`/screens?applicationId=${app.id}${query}`);

  it('every role reads (200) and the envelope carries page, pageSize and total', async () => {
    for (const user of [t.users.admin, t.users.developer, t.users.reader]) {
      const res = await get('', user.token);
      assert.equal(res.status, 200);
      assert.deepEqual([pageOf(res).page, pageOf(res).pageSize, pageOf(res).total], [1, 20, 6]);
    }
  });

  it('lists the App (OnStart) screen first, then by name ascending, and only the requested application', async () => {
    const res = await get('');
    assert.deepEqual(names(res), ['App (OnStart)', 'Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo_100%']);
    const first = pageOf(res).data[0]!;
    assert.equal(first.isAppContext, true);
    assert.equal(first.id, app.appContextScreenId);
    assert.ok(pageOf(res).data.every((s) => s.applicationId === app.id));
  });

  it('returns the ScreenSummary fields: author, pendingSubtasks (D-14) and commentCount (every comment)', async () => {
    const byName = new Map(pageOf(await get('')).data.map((s) => [s.name, s]));
    assert.deepEqual(byName.get('Alpha')?.author, { id: t.users.admin.id, name: 'Ada Admin' });
    assert.equal(byName.get('Alpha')?.pendingSubtasks, 0);
    assert.equal(byName.get('Bravo')?.pendingSubtasks, 1);
    assert.equal(byName.get('Charlie')?.pendingSubtasks, 2);
    assert.equal(byName.get('Delta')?.pendingSubtasks, 2);
    assert.equal(byName.get('Bravo')?.commentCount, 3);
    assert.equal(byName.get('Alpha')?.commentCount, 0);
    assert.equal(byName.get('Bravo')?.documentationStatus, 'DRAFT');
    assert.match(byName.get('Bravo')!.createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it('keeps the App (OnStart) screen first with every sort and either direction', async () => {
    for (const sort of ['name', '-name', 'documentationStatus', '-documentationStatus', 'updatedAt', '-updatedAt']) {
      assert.equal(names(await get(`&sort=${sort}`))[0], 'App (OnStart)', sort);
    }
    assert.deepEqual(names(await get('&sort=-name')), [
      'App (OnStart)',
      'Echo_100%',
      'Delta',
      'Charlie',
      'Bravo',
      'Alpha',
    ]);
  });

  it('sorts by pendingSubtasks over ALL the screens before paginating, with id as tie-breaker', async () => {
    const all = await get('&sort=-pendingSubtasks');
    assert.deepEqual(names(all).slice(1), ['Charlie', 'Delta', 'Bravo', 'Alpha', 'Echo_100%']);
    const asc = await get('&sort=pendingSubtasks');
    assert.deepEqual(names(asc).slice(1), ['Alpha', 'Echo_100%', 'Bravo', 'Charlie', 'Delta']);
    // Pages of two must reproduce the same sequence: the order is global and stable.
    const paged: string[] = [];
    for (const page of [1, 2, 3]) paged.push(...names(await get(`&sort=-pendingSubtasks&pageSize=2&page=${page}`)));
    assert.deepEqual(paged, names(all));
    assert.equal(pageOf(await get('&pageSize=2&page=3')).data.length, 2);
    assert.equal(pageOf(await get('&pageSize=2&page=4')).data.length, 0);
    assert.equal(pageOf(await get('&pageSize=2&page=4')).total, 6);
  });

  it('sorts by documentationStatus (enum order) and by updatedAt', async () => {
    const byStatus = names(await get('&sort=documentationStatus')).slice(1);
    assert.deepEqual(byStatus.slice(0, 3), ['Delta', 'Echo_100%', 'Bravo']); // UNDOCUMENTED..., then DRAFT
    assert.equal(byStatus.at(-1), 'Alpha'); // APPROVED
    await t.owner.query(`UPDATE screen SET updated_at = now() + interval '1 hour' WHERE id = $1`, [screens.Alpha]);
    assert.equal(names(await get('&sort=-updatedAt'))[1], 'Alpha');
  });

  it('filters by q (case-insensitive, LIKE wildcards are literal), documentationStatus and authorId', async () => {
    assert.deepEqual(names(await get('&q=ALPH')), ['Alpha']);
    assert.deepEqual(names(await get('&q=%25')), ['Echo_100%']);
    assert.deepEqual(names(await get('&q=_')), ['Echo_100%']);
    assert.deepEqual(names(await get('&documentationStatus=DRAFT')), ['Bravo', 'Charlie']);
    assert.deepEqual(names(await get(`&authorId=${t.users.developer.id}`)), ['Bravo']);
    assert.equal(pageOf(await get('&documentationStatus=DRAFT&q=char')).total, 1);
  });

  it('a filter id that matches nothing or cannot exist gives an empty page (D-70)', async () => {
    for (const authorId of [987654, 2147483648]) {
      const res = await get(`&authorId=${authorId}`);
      assert.equal(res.status, 200);
      assert.deepEqual([pageOf(res).data.length, pageOf(res).total], [0, 0]);
    }
  });

  it('400 for a missing applicationId, a bad page, sort, status or an unknown parameter', async () => {
    const missing = await asUser(t, t.users.admin.token).get('/screens');
    assert.equal(missing.status, 400);
    assert.equal(bodyOf(missing).code, 'VALIDATION_ERROR');
    assert.ok(bodyOf(missing).details.fields.some((f) => f.field === 'applicationId'));
    assert.equal((await get('&pageSize=101')).status, 400);
    assert.equal((await get('&page=0')).status, 400);
    assert.equal((await get('&documentationStatus=NOPE')).status, 400);
    assert.equal((await get('&unknown=1')).status, 400);
    const badSort = await get('&sort=author');
    assert.equal(badSort.status, 400);
    assert.equal(bodyOf(badSort).details.fields[0]?.field, 'sort');
  });

  it('404 NOT_FOUND application when the application does not exist or its id is out of range (D-70)', async () => {
    for (const id of [999999, 2147483648]) {
      const res = await asUser(t, t.users.admin.token).get(`/screens?applicationId=${id}`);
      assert.equal(res.status, 404, String(id));
      assert.equal(bodyOf(res).code, 'NOT_FOUND');
      assert.equal(bodyOf(res).message, "This application doesn't exist. It may have been deleted.");
    }
  });

  it('401 without a token, and the operation no longer answers NOT_IMPLEMENTED', async () => {
    const res = await t.http.get(`/api/v1/screens?applicationId=${app.id}`);
    assert.equal(res.status, 401);
    assert.notEqual(bodyOf(await get('')).details?.reason, 'NOT_IMPLEMENTED');
    assert.ok(!t.built.notImplemented.includes('listScreens'));
  });
});
