/**
 * Helpers of the onboarding tests: the shape of the response, a call to `GET /onboarding/summary` that must answer 200
 * and conform to the contract, and a small application ("the story") with a known summary. Everything runs on the
 * disposable database of `startTestApp`.
 */
import assert from 'node:assert/strict';
import type { TestApp } from './app.js';
import { assertConformsToContract } from './contractResponse.js';
import {
  insertApplication,
  insertCollection,
  insertComponent,
  insertDependency,
  insertScreen,
  insertScreenCollection,
  insertScreenVariable,
  insertVariable,
} from './fixtures.js';
import { asUser } from './users.js';

/** `{ id, name }`. */
export type RefBody = { id: number; name: string };

/** `data` of the response. */
export type OnboardingBody = {
  application: RefBody;
  counts: { screens: number; variables: number; collections: number; components: number };
  approvedPercent: number;
  appContextScreen: {
    id: number;
    name: string;
    documentationStatus: string;
    miroLink: string | null;
    template: Record<
      'onStart' | 'workingProcess' | 'architecture' | 'dataModel' | 'requirements' | 'knownIssues' | 'risks',
      string | null
    >;
  };
  keyScreens: {
    screen: RefBody;
    documentationStatus: string;
    connections: number;
    depth: number | null;
    miroLink: string | null;
  }[];
  globalVariables: { variable: RefBody; dataType: string; originScreen: RefBody | null; usedByScreens: number }[];
  topComponents: { component: RefBody; screen: RefBody; uses: number }[];
};

/** Typed view of a 200 response. */
export const summaryOf = (res: { body: unknown }): OnboardingBody => (res.body as { data: OnboardingBody }).data;

/** `GET /onboarding/summary` as `token`. */
export const getSummary = (t: TestApp, applicationId: number | string, token = t.users.admin.token) =>
  asUser(t, token).get(`/onboarding/summary?applicationId=${applicationId}`);

/** `GET /onboarding/summary` that must answer 200 and conform to the contract; returns `data`. */
export async function summaryOk(
  t: TestApp,
  applicationId: number,
  token = t.users.admin.token,
): Promise<OnboardingBody> {
  const res = await getSummary(t, applicationId, token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await assertConformsToContract(res);
  return summaryOf(res);
}

/** Ids and names of what `seedStory` created. */
export type Story = Awaited<ReturnType<typeof seedStory>>;

/**
 * An application with a navigation cycle, an unreachable screen, an isolated one, a variable with several usages, one
 * without origin, one never used, a CONTEXT variable, a collection and three components. Its summary:
 *
 * - counts: 6 screens, 4 variables, 1 collection, 3 components; 2 of 6 APPROVED (App (OnStart) and Home) = 33.3.
 * - key screens: Home (5 connections, depth 1), Catalog (4, 2), Detail (4, 3), Orphan (3, null), Island (1, null).
 * - global variables: gUser (3 screens), gTheme (1), gUnused (0).
 * - top components: galItems (2 uses), btnSave (1); lblIdle uses nothing.
 *
 * @param t - The test application.
 * @param name - Name of the application.
 */
export async function seedStory(t: TestApp, name = 'Onboarding story') {
  const app = await insertApplication(t, { name });
  const appId = app.id;
  const home = await insertScreen(t, appId, { name: 'Home', documentationStatus: 'APPROVED' });
  const catalog = await insertScreen(t, appId, { name: 'Catalog', documentationStatus: 'IN_REVIEW' });
  const detail = await insertScreen(t, appId, { name: 'Detail', documentationStatus: 'DRAFT' });
  const orphan = await insertScreen(t, appId, { name: 'Orphan', documentationStatus: 'DRAFT' });
  const island = await insertScreen(t, appId, { name: 'Island' });

  await t.owner.query(
    `UPDATE screen SET documentation_status = 'APPROVED', miro_link = 'https://miro.com/app/board/story=/',
            on_start = 'Loads gUser.', risks = 'None.' WHERE id = $1`,
    [app.appContextScreenId],
  );
  await t.owner.query(
    `UPDATE screen SET miro_link = 'https://miro.com/app/board/story=/?moveToWidget=1' WHERE id = $1`,
    [home.id],
  );

  const gUser = await insertVariable(t, appId, { name: 'gUser', dataType: 'TEXT', originScreenId: home.id });
  const gTheme = await insertVariable(t, appId, { name: 'gTheme', dataType: 'BOOLEAN' });
  const gUnused = await insertVariable(t, appId, { name: 'gUnused', dataType: 'DATE' });
  const cLocal = await insertVariable(t, appId, { name: 'cLocal', scope: 'CONTEXT', originScreenId: home.id });
  const colItems = await insertCollection(t, appId, { name: 'colItems' });

  const read = (screenId: number, variableId: number, usedIn: string) =>
    insertScreenVariable(t, { screenId, variableId, accessMode: 'READ', usedIn });
  await read(home.id, gUser.id, 'Label1.Text');
  await read(catalog.id, gUser.id, 'Label2.Text');
  await read(catalog.id, gUser.id, 'Label3.Text'); // the same variable twice on one screen: one screen
  await read(detail.id, gUser.id, 'Label4.Text');
  await read(orphan.id, gTheme.id, 'Screen.Fill');
  await read(home.id, cLocal.id, 'Label5.Text');
  for (const screen of [catalog, detail, orphan]) {
    await insertScreenCollection(t, {
      screenId: screen.id,
      collectionId: colItems.id,
      accessMode: 'READ',
      usedIn: 'Gallery.Items',
    });
  }

  const nav = (from: number, to: number) =>
    insertDependency(t, { sourceId: from, targetId: to, relationType: 'NAVIGATES_TO' });
  await nav(app.appContextScreenId, home.id);
  await nav(home.id, catalog.id);
  await nav(catalog.id, detail.id);
  await nav(detail.id, home.id); // a cycle
  await nav(orphan.id, island.id); // nothing reaches Orphan or Island from App (OnStart)

  const galItems = await insertComponent(t, appId, catalog.id, { name: 'galItems' });
  const btnSave = await insertComponent(t, appId, detail.id, { name: 'btnSave' });
  const lblIdle = await insertComponent(t, appId, home.id, { name: 'lblIdle' });
  const uses = (componentId: number, targetId: number) =>
    insertDependency(t, { sourceId: componentId, targetId, relationType: 'USES' });
  await uses(galItems.id, gUser.id);
  await uses(galItems.id, colItems.id);
  await uses(btnSave.id, gUser.id);

  return {
    app,
    home,
    catalog,
    detail,
    orphan,
    island,
    gUser,
    gTheme,
    gUnused,
    cLocal,
    colItems,
    galItems,
    btnSave,
    lblIdle,
  };
}
