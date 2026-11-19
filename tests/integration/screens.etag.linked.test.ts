/**
 * The ETag of a screen and the items it shows that belong to other rows (D-153): the variables, collections and screens it
 * links to, the variables used by its components, the origin text of a variable and the author. Renaming or deleting
 * any of them changes what `GET /screens/{id}` returns WITHOUT touching `updated_at` of the screen, so the fourth segment
 * of the ETag (a fingerprint of those items) must change: a `GET` with the previous `If-None-Match` is a 200 with the new
 * data, and one with the new ETag is a 304. `If-Match` still compares only the `updatedAt` part, so none of those changes
 * makes a save a 412. Runs on a disposable database; no fixed waits.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bearer, startTestApp, type TestApp } from '../helpers/app.js';
import { collectionOf, createBodyOf as collectionBody, putBodyOf as collectionPut } from '../helpers/collections.js';
import { insertApplication } from '../helpers/fixtures.js';
import {
  createScreenVia,
  putBodyOf as screenPut,
  screenOf,
  templateWith,
  type ScreenBody,
} from '../helpers/screens.js';
import { asUser, createUser } from '../helpers/users.js';
import { createBodyOf as variableBody, putBodyOf as variablePut, variableOf } from '../helpers/variables.js';

/** `W/"<updatedAt ms>-<pendingSubtasks>-<commentCount>-<8 hex>"`. */
const FOUR_PARTS = /^W\/"\d+-\d+-\d+-[0-9a-f]{8}"$/;

describe('ETag of a screen: the items of other rows (D-153)', () => {
  let t: TestApp;
  before(async () => {
    t = await startTestApp();
  });
  after(async () => {
    await t.close();
  });

  const admin = () => asUser(t, t.users.admin.token);
  const developer = () => asUser(t, t.users.developer.token);
  const read = (screenId: number, ifNoneMatch?: string) => {
    const r = t.http.get(`/api/v1/screens/${screenId}`).set('Authorization', bearer(t.users.reader.token));
    return ifNoneMatch === undefined ? r : r.set('If-None-Match', ifNoneMatch);
  };

  /** A screen with a linked variable, a linked collection, a navigation, a component that uses a variable and an origin. */
  async function arrange(creator: ReturnType<typeof developer> = developer()) {
    const application = await insertApplication(t);
    const appId = application.id;
    const target = (await createScreenVia(creator, appId, { name: `Target ${appId}` })).screen;
    const linkedVar = variableOf(await admin().post('/variables', variableBody(appId, { name: `gLinked${appId}` })));
    const usedVar = variableOf(await admin().post('/variables', variableBody(appId, { name: `gUsed${appId}` })));
    const collection = collectionOf(await admin().post('/collections', collectionBody(appId, { name: `col${appId}` })));
    const created = await createScreenVia(creator, appId, {
      name: `Main ${appId}`,
      variableLinks: [{ variableId: linkedVar.id, accessMode: 'READ', usedIn: 'c1.OnSelect' }],
      collectionLinks: [{ collectionId: collection.id, accessMode: 'READ', usedIn: 'c1.OnSelect' }],
      navigations: [{ targetScreenId: target.id }],
      components: [{ name: 'c1', type: 'Button', uses: [{ targetType: 'VARIABLE', targetId: usedVar.id }] }],
    });
    const origin = variableOf(
      await admin().post(
        '/variables',
        variableBody(appId, { name: `gOrigin${appId}`, originScreenId: created.screen.id, originUsedIn: 'OnStart' }),
      ),
    );
    const screen = screenOf(await read(created.screen.id));
    assert.equal(screen.variableLinks.length, 2, 'the linked variable and the origin row');
    return { appId, screen, target, linkedVar, usedVar, collection, origin };
  }

  /** The case: `GET` with the old ETag is 200 with the new data; with the new one, 304. */
  async function assertMoves(screenId: number, before: string, assertData: (s: ScreenBody) => void): Promise<void> {
    const res = await read(screenId, before);
    assert.equal(res.status, 200, 'the old ETag no longer matches');
    assertData(screenOf(res));
    const after = String(res.headers.etag);
    assert.match(after, FOUR_PARTS);
    assert.notEqual(after, before);
    assert.equal((await read(screenId, after)).status, 304, 'the new ETag does');
  }

  it('is four parts, the same in GET, POST and PUT, and a screen that nothing changed is a 304', async () => {
    const { screen } = await arrange();
    const got = await read(screen.id);
    assert.match(String(got.headers.etag), FOUR_PARTS);
    assert.equal((await read(screen.id, String(got.headers.etag))).status, 304);
    const put = await developer().put(`/screens/${screen.id}`, screenPut(screen));
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.headers.etag, (await read(screen.id)).headers.etag, 'PUT and GET send the same tag');
    const posted = await createScreenVia(developer(), screen.applicationId, { name: 'Plain' });
    assert.equal(posted.etag, String((await read(posted.screen.id)).headers.etag), 'POST and GET send the same tag');
  });

  it('a linked variable is renamed: 200 with the new name, then 304', async () => {
    const { screen, linkedVar } = await arrange();
    const before = String((await read(screen.id)).headers.etag);
    const res = await admin().put(
      `/variables/${linkedVar.id}`,
      variablePut(linkedVar, { name: `${linkedVar.name}New` }),
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await assertMoves(screen.id, before, (s) =>
      assert.ok(s.variableLinks.some((l) => l.variable.name === `${linkedVar.name}New`)),
    );
  });

  it('the originUsedIn of the origin variable is edited: 200 with the new text, then 304', async () => {
    const { screen, origin } = await arrange();
    const before = String((await read(screen.id)).headers.etag);
    const res = await admin().put(`/variables/${origin.id}`, variablePut(origin, { originUsedIn: 'OnVisible' }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await assertMoves(screen.id, before, (s) =>
      assert.equal(s.variableLinks.find((l) => l.isOrigin)?.originUsedIn, 'OnVisible'),
    );
  });

  it('a linked collection is renamed: 200 with the new name, then 304', async () => {
    const { screen, collection } = await arrange();
    const before = String((await read(screen.id)).headers.etag);
    const res = await admin().put(
      `/collections/${collection.id}`,
      collectionPut(collection, { name: `${collection.name}New` }),
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await assertMoves(screen.id, before, (s) =>
      assert.equal(s.collectionLinks[0]!.collection.name, `${collection.name}New`),
    );
  });

  it('the target screen of a navigation is renamed: 200 with the new name, then 304', async () => {
    const { screen, target } = await arrange();
    const before = String((await read(screen.id)).headers.etag);
    const res = await developer().put(`/screens/${target.id}`, screenPut(target, { name: `${target.name} renamed` }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await assertMoves(screen.id, before, (s) =>
      assert.equal(s.navigations[0]!.targetScreen.name, `${target.name} renamed`),
    );
  });

  it('a variable used by a component is renamed: 200 with the new name, then 304', async () => {
    const { screen, usedVar } = await arrange();
    const before = String((await read(screen.id)).headers.etag);
    const res = await admin().put(`/variables/${usedVar.id}`, variablePut(usedVar, { name: `${usedVar.name}New` }));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await assertMoves(screen.id, before, (s) =>
      assert.equal(s.components[0]!.uses[0]!.target.name, `${usedVar.name}New`),
    );
  });

  it('a linked variable is deleted: 200 without the link, then 304', async () => {
    const { screen, linkedVar } = await arrange();
    const before = String((await read(screen.id)).headers.etag);
    assert.equal((await admin().delete(`/variables/${linkedVar.id}`)).status, 204);
    await assertMoves(screen.id, before, (s) =>
      assert.ok(!s.variableLinks.some((l) => l.variable.id === linkedVar.id)),
    );
  });

  it('the author is renamed: 200 with the new name, then 304', async () => {
    const author = await createUser(t, t.users.admin.token, { name: 'Original Author' });
    const { screen } = await arrange(asUser(t, author.token));
    assert.equal(screen.author.name, 'Original Author');
    const before = String((await read(screen.id)).headers.etag);
    const res = await admin().put(`/users/${author.user.id}`, {
      name: 'Renamed Author',
      email: author.email,
      status: author.user.status,
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await assertMoves(screen.id, before, (s) => assert.equal(s.author.name, 'Renamed Author'));
  });

  it('a PUT with the If-Match read BEFORE renaming a linked item is a 200, not a 412', async () => {
    const { screen, linkedVar } = await arrange();
    const ifMatch = String((await read(screen.id)).headers.etag);
    const renamed = await admin().put(
      `/variables/${linkedVar.id}`,
      variablePut(linkedVar, { name: `${linkedVar.name}X` }),
    );
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    const res = await developer().put(
      `/screens/${screen.id}`,
      screenPut(screen, { template: templateWith({ onStart: 'edited' }) }),
      ifMatch,
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(String(res.headers.etag), FOUR_PARTS);
    assert.equal(res.headers.etag, (await read(screen.id)).headers.etag);
  });

  it('If-Match accepts the three formats and any other one is a 412 with the full current ETag', async () => {
    const { screen } = await arrange();
    const full = String((await read(screen.id)).headers.etag);
    const ms = /^W\/"(\d+)-/.exec(full)![1]!;
    for (const accepted of [`W/"${ms}"`, `W/"${ms}-0-0"`, full]) {
      const res = await developer().put(`/screens/${screen.id}`, screenPut(screen), accepted);
      assert.equal(res.status, 200, `${accepted}: ${JSON.stringify(res.body)}`);
    }
    const rejected = [`W/"${ms}-0"`, `W/"${ms}-0-0-zz"`, `W/"${ms}-0-0-abcdef123"`, `"${ms}"`, `${full}-x`, 'W/"abc"'];
    for (const value of rejected) {
      const res = await developer().put(`/screens/${screen.id}`, screenPut(screen), value);
      assert.equal(res.status, 412, value);
      assert.equal((res.body as { details: { currentETag: string } }).details.currentETag, full);
    }
  });
});
