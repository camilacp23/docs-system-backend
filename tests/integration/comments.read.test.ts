/**
 * Module 10, GET /screens/{id}/comments (FR-23; D-56, D-72, D-122): oldest first (createdAt, then id), paging, the 400
 * of page and pageSize, the 404, the review comments in the same thread, an inactive author, and the ETag by hash of the
 * body with its 304. Every response is checked against the contract.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bearer, bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { commentsPageOf, insertCommentRow } from '../helpers/comments.js';
import { assertConformsToContract } from '../helpers/contractResponse.js';
import { insertApplication, insertScreen } from '../helpers/fixtures.js';
import { createScreenInStatus, fullTemplate, screenOf } from '../helpers/screens.js';
import { asUser } from '../helpers/users.js';

describe('comments: GET /screens/{id}/comments', () => {
  let t: TestApp;
  let screenId: number;

  before(async () => {
    t = await startTestApp();
    const app = await insertApplication(t, { name: 'Commented' });
    screenId = (await insertScreen(t, app.id)).id;
    // Inserted out of order on purpose: the order comes from createdAt, and `id` breaks the tie of the last two.
    await insertCommentRow(t, screenId, t.users.developer.id, 'third', { createdAt: '2026-11-03T10:00:00Z' });
    await insertCommentRow(t, screenId, t.users.admin.id, 'first', { createdAt: '2026-11-01T10:00:00Z' });
    await insertCommentRow(t, screenId, t.users.inactive.id, 'second', { createdAt: '2026-11-02T10:00:00Z' });
    await insertCommentRow(t, screenId, t.users.reader.id, 'fourth', { createdAt: '2026-11-03T10:00:00Z' });
  });
  after(async () => {
    await t.close();
  });

  const as = (role: 'admin' | 'developer' | 'reader') => asUser(t, t.users[role].token);
  const conditional = (url: string, etag: string) =>
    t.http.get(`/api/v1${url}`).set('Authorization', bearer(t.users.reader.token)).set('If-None-Match', etag);

  it('returns the thread oldest first, the same for the three roles, conforming to the contract', async () => {
    for (const role of ['admin', 'developer', 'reader'] as const) {
      const res = await as(role).get(`/screens/${screenId}/comments`);
      assert.equal(res.status, 200, role);
      await assertConformsToContract(res);
      const page = commentsPageOf(res);
      assert.deepEqual(
        page.data.map((c) => c.text),
        ['first', 'second', 'third', 'fourth'],
        role,
      );
      assert.equal(page.total, 4);
      assert.equal(page.page, 1);
      assert.equal(page.pageSize, 20);
    }
  });

  it('shows the author even when the user is inactive, and every field of the contract', async () => {
    const page = commentsPageOf(await as('reader').get(`/screens/${screenId}/comments`));
    const second = page.data[1]!;
    assert.deepEqual(second.author, { id: t.users.inactive.id, name: 'Ina Ctive' });
    assert.equal(second.screenId, screenId);
    assert.equal(second.reviewDecision, null);
    assert.equal(second.updatedAt, null);
    assert.equal(second.createdAt, '2026-11-02T10:00:00.000Z');
  });

  it('pages: pageSize and page, with the same total', async () => {
    const one = commentsPageOf(await as('admin').get(`/screens/${screenId}/comments?pageSize=3`));
    assert.deepEqual(
      one.data.map((c) => c.text),
      ['first', 'second', 'third'],
    );
    const two = await as('admin').get(`/screens/${screenId}/comments?pageSize=3&page=2`);
    await assertConformsToContract(two);
    assert.deepEqual(
      commentsPageOf(two).data.map((c) => c.text),
      ['fourth'],
    );
    assert.equal(commentsPageOf(two).total, 4);
    const beyond = commentsPageOf(await as('admin').get(`/screens/${screenId}/comments?page=9`));
    assert.deepEqual(beyond.data, []);
    assert.equal(beyond.total, 4);
  });

  it('400 for page and pageSize out of range, with the contract error shape', async () => {
    for (const query of ['page=0', 'page=-1', 'pageSize=0', 'pageSize=101', 'page=x']) {
      const res = await as('admin').get(`/screens/${screenId}/comments?${query}`);
      assert.equal(res.status, 400, query);
      assert.equal(bodyOf(res).code, 'VALIDATION_ERROR', query);
      await assertConformsToContract(res);
    }
  });

  it('404 NOT_FOUND for a screen that does not exist or whose id cannot exist; 400 for a text id; 401 without token', async () => {
    for (const id of [999999, 2147483647, 2147483648]) {
      const res = await as('reader').get(`/screens/${id}/comments`);
      assert.equal(res.status, 404, String(id));
      assert.equal(bodyOf(res).message, "This screen doesn't exist. It may have been deleted.");
      await assertConformsToContract(res);
    }
    assert.equal((await as('reader').get('/screens/abc/comments')).status, 400);
    assert.equal((await t.http.get(`/api/v1/screens/${screenId}/comments`)).status, 401);
  });

  it('an empty thread is an empty page, not a 404', async () => {
    const app = await insertApplication(t);
    const empty = (await insertScreen(t, app.id)).id;
    const res = await as('reader').get(`/screens/${empty}/comments`);
    assert.equal(res.status, 200);
    assert.deepEqual(commentsPageOf(res).data, []);
    assert.equal(commentsPageOf(res).total, 0);
  });

  it('the review comments are in the same thread with their reviewDecision (D-56)', async () => {
    const app = await insertApplication(t);
    const { screen } = await createScreenInStatus(t, as('developer'), app.id, 'IN_REVIEW', fullTemplate());
    await insertCommentRow(t, screen.id, t.users.developer.id, 'ordinary', { createdAt: '2026-11-01T10:00:00Z' });
    const review = await as('admin').post(`/screens/${screen.id}/review`, { decision: 'RETURN', comment: 'Fix it' });
    assert.equal(review.status, 200, JSON.stringify(review.body));
    assert.equal(screenOf(review).commentCount, 2);
    const res = await as('reader').get(`/screens/${screen.id}/comments`);
    await assertConformsToContract(res);
    assert.deepEqual(
      commentsPageOf(res).data.map((c) => [c.text, c.reviewDecision, c.author.id]),
      [
        ['ordinary', null, t.users.developer.id],
        ['Fix it', 'RETURN', t.users.admin.id],
      ],
    );
  });

  it('ETag by hash of the body (D-72): a 304 for the same body and a new tag when a comment is added', async () => {
    const url = `/screens/${screenId}/comments`;
    const etag = String((await as('reader').get(url)).headers.etag);
    assert.match(etag, /^W\/"[^"]+"$/);
    const again = await conditional(url, etag);
    assert.equal(again.status, 304);
    assert.deepEqual(again.body, {});
    await insertCommentRow(t, screenId, t.users.admin.id, 'fifth', { createdAt: '2026-11-04T10:00:00Z' });
    const changed = await conditional(url, etag);
    assert.equal(changed.status, 200);
    assert.notEqual(String(changed.headers.etag), etag);
  });
});
