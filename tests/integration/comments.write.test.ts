/**
 * Module 10, POST /screens/{id}/comments (FR-23; D-47, D-122, D-123): the three roles, the text stored as it arrives,
 * the 400 of an empty or blank text, the order of errors (400, 404, 422 APPLICATION_ARCHIVED), any screen status
 * (IN_REVIEW included), the 201 with its ETag and without Location, `reviewDecision` always null and the audit trail.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { commentOf, commentsPageOf, etagFromItem, storedComments } from '../helpers/comments.js';
import { assertConformsToContract } from '../helpers/contractResponse.js';
import { insertApplication, insertScreen, setApplicationStatus } from '../helpers/fixtures.js';
import { asUser } from '../helpers/users.js';

/** The `details` of an error response as sent (null when the error has none). */
const rawDetails = (res: { body: unknown }): unknown => (res.body as { details: unknown }).details;

describe('comments: POST /screens/{id}/comments', () => {
  let t: TestApp;
  let app: { id: number };
  let screenId: number;

  before(async () => {
    t = await startTestApp();
    app = await insertApplication(t, { name: 'Writers' });
    screenId = (await insertScreen(t, app.id)).id;
  });
  after(async () => {
    await t.close();
  });

  const as = (role: 'admin' | 'developer' | 'reader') => asUser(t, t.users[role].token);
  const post = (role: 'admin' | 'developer' | 'reader', id: number, body: object) =>
    as(role).post(`/screens/${id}/comments`, body);

  it('201 for the three roles: the author is the caller, reviewDecision null, updatedAt null, conforming to the contract', async () => {
    for (const role of ['admin', 'developer', 'reader'] as const) {
      const res = await post(role, screenId, { text: `Comment of ${role}` });
      assert.equal(res.status, 201, role);
      await assertConformsToContract(res);
      const c = commentOf(res);
      assert.equal(c.author.id, t.users[role].id, role);
      assert.equal(c.screenId, screenId);
      assert.equal(c.text, `Comment of ${role}`);
      assert.equal(c.reviewDecision, null);
      assert.equal(c.updatedAt, null);
      assert.ok(Number.isFinite(Date.parse(c.createdAt)));
    }
  });

  it('the 201 has the ETag of D-123 (W/"<ms of createdAt>") and NO Location', async () => {
    const res = await post('developer', screenId, { text: 'With a tag' });
    assert.equal(res.status, 201);
    const c = commentOf(res);
    assert.equal(res.headers.etag, `W/"${Date.parse(c.createdAt)}"`);
    assert.equal(res.headers.etag, etagFromItem(c));
    assert.equal(res.headers.location, undefined);
  });

  it('stores the text as it arrives: no trimming, internal and edge whitespace and line breaks kept', async () => {
    const text = '  first line\n\n   second line with  spaces \t\n ';
    const res = await post('reader', screenId, { text });
    assert.equal(res.status, 201);
    assert.equal(commentOf(res).text, text);
    const stored = (await storedComments(t, screenId)).find((r) => r.id === commentOf(res).id);
    assert.equal(stored?.text, text);
  });

  it('accepts 4000 characters and a text with accents and emoji, and shows up in the list in order', async () => {
    const long = await post('admin', screenId, { text: 'a'.repeat(4000) });
    assert.equal(long.status, 201);
    const accents = await post('admin', screenId, { text: 'Ñandú: señal ✓ 日本語 🙂' });
    assert.equal(accents.status, 201);
    assert.equal(commentOf(accents).text, 'Ñandú: señal ✓ 日本語 🙂');
    const list = commentsPageOf(await as('reader').get(`/screens/${screenId}/comments?pageSize=100`));
    const ids = list.data.map((c) => c.id);
    assert.deepEqual(
      ids,
      [...ids].sort((a, b) => a - b),
    );
    assert.ok(ids.includes(commentOf(long).id) && ids.includes(commentOf(accents).id));
  });

  it('400 VALIDATION_ERROR for an empty or blank text (rule pattern), a text over 4000, a missing text and extra fields', async () => {
    const before = (await storedComments(t, screenId)).length;
    const bad: [string, object][] = [
      ['empty', { text: '' }],
      ['spaces', { text: '    ' }],
      ['tabs and line breaks', { text: ' \n\t \r\n ' }],
      ['over 4000', { text: 'a'.repeat(4001) }],
      ['missing text', {}],
      ['null text', { text: null }],
      ['number', { text: 5 }],
      ['review decision is not accepted', { text: 'x', reviewDecision: 'APPROVE' }],
      ['extra field', { text: 'x', screenId: 1 }],
    ];
    for (const [name, body] of bad) {
      const res = await post('developer', screenId, body);
      assert.equal(res.status, 400, name);
      assert.equal(bodyOf(res).code, 'VALIDATION_ERROR', name);
      await assertConformsToContract(res);
    }
    const blank = await post('developer', screenId, { text: '   ' });
    assert.equal(bodyOf(blank).details.fields[0]?.field, 'text');
    assert.equal(bodyOf(blank).details.fields[0]?.rule, 'pattern');
    assert.equal((await storedComments(t, screenId)).length, before, 'nothing was written');
  });

  it('400 when the body is not JSON; 400 for a text id; 401 without a token', async () => {
    const res = await t.http
      .post(`/api/v1/screens/${screenId}/comments`)
      .set('Authorization', `Bearer ${t.users.admin.token}`)
      .set('Content-Type', 'application/json')
      .send('{"text":');
    assert.equal(res.status, 400);
    assert.equal((await as('admin').post('/screens/abc/comments', { text: 'x' })).status, 400);
    assert.equal((await t.http.post(`/api/v1/screens/${screenId}/comments`).send({ text: 'x' })).status, 401);
  });

  it('404 NOT_FOUND for a screen that does not exist or whose id cannot exist', async () => {
    for (const id of [999999, 2147483647, 2147483648]) {
      const res = await post('developer', id, { text: 'x' });
      assert.equal(res.status, 404, String(id));
      assert.equal(bodyOf(res).message, "This screen doesn't exist. It may have been deleted.");
      await assertConformsToContract(res);
    }
  });

  it('is allowed on a screen in any status, IN_REVIEW included, and it does not change the status', async () => {
    for (const status of ['UNDOCUMENTED', 'DRAFT', 'IN_PROGRESS', 'IN_REVIEW', 'APPROVED'] as const) {
      const screen = await insertScreen(t, app.id, { documentationStatus: status });
      const res = await post('reader', screen.id, { text: `On ${status}` });
      assert.equal(res.status, 201, status);
      const read = await as('reader').get(`/screens/${screen.id}`);
      assert.equal((read.body as { data: { documentationStatus: string } }).data.documentationStatus, status);
    }
  });

  describe('archived application (CP-01, D-47)', () => {
    it('422 APPLICATION_ARCHIVED for every role, nothing is written, and the application can be unarchived', async () => {
      const archived = await insertApplication(t, { status: 'ARCHIVED' });
      const screen = await insertScreen(t, archived.id);
      for (const role of ['admin', 'developer', 'reader'] as const) {
        const res = await post(role, screen.id, { text: 'Too late' });
        assert.equal(res.status, 422, role);
        assert.equal(bodyOf(res).code, 'APPLICATION_ARCHIVED');
        assert.equal(bodyOf(res).message, "This application is archived, so its documentation can't be changed.");
        assert.deepEqual(rawDetails(res), { applicationId: archived.id });
        await assertConformsToContract(res);
      }
      assert.equal((await storedComments(t, screen.id)).length, 0);
      await setApplicationStatus(t, archived.id, 'ACTIVE');
      assert.equal((await post('reader', screen.id, { text: 'Back' })).status, 201);
    });

    it('the order is 400, then 404, then 422: a blank text is a 400 even if the application is archived', async () => {
      const archived = await insertApplication(t, { status: 'ARCHIVED' });
      const screen = await insertScreen(t, archived.id);
      assert.equal((await post('admin', screen.id, { text: '  ' })).status, 400);
      assert.equal((await post('admin', 999999, { text: 'x' })).status, 404);
      assert.equal((await post('admin', screen.id, { text: 'x' })).status, 422);
    });

    it('the comments of an archived application can still be read', async () => {
      const archived = await insertApplication(t);
      const screen = await insertScreen(t, archived.id);
      assert.equal((await post('admin', screen.id, { text: 'Before archiving' })).status, 201);
      await setApplicationStatus(t, archived.id, 'ARCHIVED');
      const res = await as('reader').get(`/screens/${screen.id}/comments`);
      assert.equal(res.status, 200);
      assert.equal(commentsPageOf(res).total, 1);
    });
  });

  it('audit trail: one CREATE row in audit_log with the caller as the actor and the text as written', async () => {
    const screen = await insertScreen(t, app.id);
    const text = '  audited  ';
    const res = await post('developer', screen.id, { text });
    const id = commentOf(res).id;
    const rows = (
      await t.owner.query<{
        actor_user_id: number;
        application_id: number;
        new_value: { text: string; screen_id: number; user_id: number; review_decision: string | null };
      }>(
        `SELECT actor_user_id, application_id, new_value FROM audit_log
          WHERE entity_type = 'comment' AND entity_id = $1 AND action = 'CREATE'`,
        [String(id)],
      )
    ).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.actor_user_id, t.users.developer.id);
    assert.equal(rows[0]!.application_id, app.id);
    assert.equal(rows[0]!.new_value.text, text);
    assert.equal(rows[0]!.new_value.review_decision, null);
  });
});
