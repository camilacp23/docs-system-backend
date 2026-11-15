/**
 * Module 10, PUT /comments/{id} (FR-23; D-71, D-123, D-132): the order of errors (400, 404, 403 AUTHOR_ONLY, 422
 * APPLICATION_ARCHIVED, 412, 422 REVIEW_COMMENT_LOCKED), the same text that writes nothing, the ETag of the comment, the
 * `updatedAt` that only grows, and the audit trail that keeps the previous text.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import {
  commentOf,
  commentsPageOf,
  etagFromItem,
  insertCommentRow,
  storedComments,
  waitForLockWaiters,
} from '../helpers/comments.js';
import { assertConformsToContract } from '../helpers/contractResponse.js';
import { insertApplication, insertScreen, setApplicationStatus } from '../helpers/fixtures.js';
import { createScreenInStatus, fullTemplate } from '../helpers/screens.js';
import { asUser } from '../helpers/users.js';

type Role = 'admin' | 'developer' | 'reader';

/** The `details` of an error response as sent (null when the error has none). */
const rawDetails = (res: { body: unknown }): unknown => (res.body as { details: unknown }).details;

describe('comments: PUT /comments/{id}', () => {
  let t: TestApp;
  let app: { id: number };
  let screenId: number;

  before(async () => {
    t = await startTestApp();
    app = await insertApplication(t, { name: 'Editors' });
    screenId = (await insertScreen(t, app.id)).id;
  });
  after(async () => {
    await t.close();
  });

  const as = (role: Role) => asUser(t, t.users[role].token);
  const create = async (role: Role, text = 'Original', onScreen = screenId) => {
    const res = await as(role).post(`/screens/${onScreen}/comments`, { text });
    assert.equal(res.status, 201);
    return { comment: commentOf(res), etag: String(res.headers.etag) };
  };
  const edit = (role: Role, id: number, text: string, ifMatch?: string) =>
    as(role).put(`/comments/${id}`, { text }, ifMatch);
  const auditRows = async (id: number) =>
    (
      await t.owner.query<{
        action: string;
        actor_user_id: number;
        changed_fields: string[] | null;
        old_value: { text: string; updated_at: string | null } | null;
        new_value: { text: string; updated_at: string | null } | null;
      }>(
        `SELECT action, actor_user_id, changed_fields, old_value, new_value FROM audit_log
          WHERE entity_type = 'comment' AND entity_id = $1 ORDER BY id`,
        [String(id)],
      )
    ).rows;

  describe('the author edits', () => {
    for (const role of ['admin', 'developer', 'reader'] as const) {
      it(`200 for the ${role} on their own comment: new text, updatedAt set, new ETag, conforming to the contract`, async () => {
        const { comment, etag } = await create(role);
        const res = await edit(role, comment.id, `Edited by ${role}`, etag);
        assert.equal(res.status, 200);
        await assertConformsToContract(res);
        const updated = commentOf(res);
        assert.equal(updated.text, `Edited by ${role}`);
        assert.ok(updated.updatedAt !== null && Date.parse(updated.updatedAt) > Date.parse(comment.createdAt));
        assert.deepEqual({ ...updated, text: '', updatedAt: null }, { ...comment, text: '', updatedAt: null });
        assert.equal(res.headers.etag, `W/"${Date.parse(updated.updatedAt)}"`);
        assert.notEqual(res.headers.etag, etag);
        assert.equal(res.headers.location, undefined);
      });
    }

    it('stores the text as it arrives (spaces and line breaks kept) and counts a whitespace-only difference as a change', async () => {
      const { comment, etag } = await create('developer', 'plain');
      const res = await edit('developer', comment.id, '  plain\n ', etag);
      assert.equal(res.status, 200);
      assert.equal(commentOf(res).text, '  plain\n ');
      assert.notEqual(commentOf(res).updatedAt, null, 'the text changed, even if only by spaces');
      assert.equal((await storedComments(t, screenId)).find((r) => r.id === comment.id)?.text, '  plain\n ');
    });

    it('the If-Match is optional and the ETag of an item of the list is accepted as If-Match', async () => {
      const { comment } = await create('reader', 'listed');
      assert.equal((await edit('reader', comment.id, 'no precondition')).status, 200);
      const item = commentsPageOf(await as('reader').get(`/screens/${screenId}/comments?pageSize=100`)).data.find(
        (c) => c.id === comment.id,
      )!;
      const res = await edit('reader', comment.id, 'from the list', etagFromItem(item));
      assert.equal(res.status, 200);
      assert.equal(commentOf(res).text, 'from the list');
    });

    it('audit trail: an UPDATE row with the caller as actor, the previous text in old_value and the new one in new_value', async () => {
      const { comment, etag } = await create('developer', 'before the edit');
      const res = await edit('developer', comment.id, 'after the edit', etag);
      assert.equal(res.status, 200);
      const rows = await auditRows(comment.id);
      assert.deepEqual(
        rows.map((r) => r.action),
        ['CREATE', 'UPDATE'],
      );
      const update = rows[1]!;
      assert.equal(update.actor_user_id, t.users.developer.id);
      assert.deepEqual(update.changed_fields, ['text']);
      assert.equal(update.old_value?.text, 'before the edit');
      assert.equal(update.new_value?.text, 'after the edit');
    });
  });

  describe('the same text writes nothing (D-71, D-123)', () => {
    it('200 with the same ETag, the same updatedAt (null if never edited), no new audit row and the row untouched', async () => {
      const { comment, etag } = await create('developer', ' same text ');
      const before = await auditRows(comment.id);
      const stored = (await storedComments(t, screenId)).find((r) => r.id === comment.id);
      const res = await edit('developer', comment.id, ' same text ', etag);
      assert.equal(res.status, 200);
      await assertConformsToContract(res);
      assert.deepEqual(commentOf(res), comment);
      assert.equal(res.headers.etag, etag);
      assert.equal(commentOf(res).updatedAt, null);
      assert.deepEqual(await auditRows(comment.id), before);
      assert.deepEqual(
        (await storedComments(t, screenId)).find((r) => r.id === comment.id),
        stored,
      );
    });

    it('after a real edit, repeating the text keeps that updatedAt and ETag', async () => {
      const { comment, etag } = await create('admin', 'v1');
      const edited = await edit('admin', comment.id, 'v2', etag);
      const again = await edit('admin', comment.id, 'v2', String(edited.headers.etag));
      assert.equal(again.status, 200);
      assert.equal(again.headers.etag, edited.headers.etag);
      assert.equal(commentOf(again).updatedAt, commentOf(edited).updatedAt);
      assert.equal((await auditRows(comment.id)).length, 2);
    });

    it('the If-Match is checked even when the text does not change: a stale one is a 412', async () => {
      const { comment, etag } = await create('developer', 'unchanged');
      await edit('developer', comment.id, 'changed once', etag);
      const res = await edit('developer', comment.id, 'changed once', etag);
      assert.equal(res.status, 412);
      assert.equal(bodyOf(res).code, 'PRECONDITION_FAILED');
    });
  });

  describe('412 PRECONDITION_FAILED', () => {
    it('a stale If-Match: nothing is written and details.currentETag is the current tag', async () => {
      const { comment, etag } = await create('developer', 'v1');
      const first = await edit('developer', comment.id, 'v2', etag);
      const before = await auditRows(comment.id);
      const stale = await edit('developer', comment.id, 'v3', etag);
      assert.equal(stale.status, 412);
      await assertConformsToContract(stale);
      assert.equal(
        bodyOf(stale).message,
        'Someone else saved changes to this comment after you opened it. Reload to see their version.',
      );
      assert.deepEqual(rawDetails(stale), { element: 'comment', currentETag: first.headers.etag });
      assert.deepEqual(await auditRows(comment.id), before);
      for (const bad of ['W/"1"', '"x"', 'garbage', '*']) {
        const res = await edit('developer', comment.id, 'v4', bad);
        assert.equal(res.status, 412, bad);
      }
    });
  });

  describe('order of the errors: 400, 404, 403, 422 archived, 412, 422 locked', () => {
    it('400 before everything: a blank or missing text on a comment that does not exist or is not yours', async () => {
      const { comment } = await create('developer');
      for (const body of [{ text: '' }, { text: '   ' }, {}, { text: 'x'.repeat(4001) }, { text: 'x', extra: 1 }]) {
        const res = await as('reader').put(`/comments/${comment.id}`, body, 'W/"1"');
        assert.equal(res.status, 400, JSON.stringify(body).slice(0, 30));
        await assertConformsToContract(res);
      }
      assert.equal((await as('reader').put('/comments/999999', { text: ' ' })).status, 400);
      assert.equal((await as('reader').put('/comments/abc', { text: 'x' })).status, 400);
    });

    it('404 NOT_FOUND before 403 and 412, also for an id out of the integer range', async () => {
      for (const id of [999999, 2147483647, 2147483648]) {
        const res = await edit('reader', id, 'x', 'W/"1"');
        assert.equal(res.status, 404, String(id));
        assert.equal(bodyOf(res).message, "This comment doesn't exist. It may have been deleted.");
        await assertConformsToContract(res);
      }
    });

    it('403 FORBIDDEN AUTHOR_ONLY before 422 and 412: another user, whatever the role (an administrator included)', async () => {
      const { comment, etag } = await create('developer', 'mine');
      for (const role of ['admin', 'reader'] as const) {
        const res = await edit(role, comment.id, 'not yours', 'W/"1"');
        assert.equal(res.status, 403, role);
        await assertConformsToContract(res);
        assert.equal(bodyOf(res).code, 'FORBIDDEN');
        assert.equal(bodyOf(res).message, 'You can only edit your own comments.');
        assert.deepEqual(rawDetails(res), { reason: 'AUTHOR_ONLY' });
      }
      // The comment of a user who is now inactive can't be edited by anybody else either.
      const ofInactive = await insertCommentRow(t, screenId, t.users.inactive.id, 'from the past');
      assert.equal((await edit('admin', ofInactive, 'x')).status, 403);
      const read = commentsPageOf(await as('reader').get(`/screens/${screenId}/comments?pageSize=100`)).data;
      assert.equal(read.find((c) => c.id === comment.id)?.text, 'mine');
      assert.equal((await edit('developer', comment.id, 'yes', etag)).status, 200);
    });

    it('403 comes before 422 APPLICATION_ARCHIVED, and 422 before 412', async () => {
      const own = await insertApplication(t);
      const screen = await insertScreen(t, own.id);
      const { comment, etag } = await create('developer', 'in an app', screen.id);
      await setApplicationStatus(t, own.id, 'ARCHIVED');
      const notAuthor = await edit('reader', comment.id, 'x', etag);
      assert.equal(notAuthor.status, 403);
      const archived = await edit('developer', comment.id, 'x', 'W/"1"');
      assert.equal(archived.status, 422, 'a stale If-Match does not hide the archived application');
      assert.equal(bodyOf(archived).code, 'APPLICATION_ARCHIVED');
      assert.deepEqual(rawDetails(archived), { applicationId: own.id });
      await assertConformsToContract(archived);
      // The same text on an archived application is refused too: nothing is a write there, but the rule is for every PUT.
      assert.equal((await edit('developer', comment.id, 'in an app', etag)).status, 422);
      await setApplicationStatus(t, own.id, 'ACTIVE');
      assert.equal((await edit('developer', comment.id, 'back', etag)).status, 200);
    });

    it('412 comes before 422 REVIEW_COMMENT_LOCKED, and a review comment is locked even for its author', async () => {
      const own = await insertApplication(t);
      const { screen } = await createScreenInStatus(t, as('developer'), own.id, 'IN_REVIEW', fullTemplate());
      const review = await as('admin').post(`/screens/${screen.id}/review`, {
        decision: 'RETURN',
        comment: 'Fix this',
      });
      assert.equal(review.status, 200);
      const item = commentsPageOf(await as('admin').get(`/screens/${screen.id}/comments`)).data[0]!;
      assert.equal(item.reviewDecision, 'RETURN');
      const stale = await edit('admin', item.id, 'rewritten', 'W/"1"');
      assert.equal(stale.status, 412);
      const locked = await edit('admin', item.id, 'rewritten', etagFromItem(item));
      assert.equal(locked.status, 422);
      assert.equal(bodyOf(locked).code, 'REVIEW_COMMENT_LOCKED');
      assert.equal(bodyOf(locked).message, "Review decisions can't be edited.");
      assert.equal(rawDetails(locked), null);
      await assertConformsToContract(locked);
      // The same text is refused too: a review comment is the record of the decision.
      assert.equal((await edit('admin', item.id, 'Fix this', etagFromItem(item))).status, 422);
      assert.equal((await edit('admin', item.id, 'rewritten')).status, 422);
      // Other users still get the 403 first.
      assert.equal((await edit('developer', item.id, 'x')).status, 403);
      const after = commentsPageOf(await as('admin').get(`/screens/${screen.id}/comments`)).data[0]!;
      assert.equal(after.text, 'Fix this');
      assert.equal(after.updatedAt, null);
    });

    it('401 without a token', async () => {
      const { comment } = await create('developer');
      assert.equal((await t.http.put(`/api/v1/comments/${comment.id}`).send({ text: 'x' })).status, 401);
    });
  });

  describe('updatedAt only grows (D-132)', () => {
    it('five edits in a row give five different, increasing ETags and updatedAt, even within the same millisecond', async () => {
      const { comment, etag } = await create('developer', 'e0');
      let previous = { etag, ms: Date.parse(comment.createdAt) };
      let ifMatch = etag;
      for (let i = 1; i <= 5; i += 1) {
        const res = await edit('developer', comment.id, `e${i}`, ifMatch);
        assert.equal(res.status, 200, `edit ${i}`);
        const ms = Date.parse(commentOf(res).updatedAt!);
        assert.ok(ms > previous.ms, `edit ${i}: ${ms} > ${previous.ms}`);
        assert.notEqual(res.headers.etag, previous.etag);
        assert.equal(res.headers.etag, `W/"${ms}"`, 'the tag and the response agree with what is stored');
        const stored = (await storedComments(t, screenId)).find((r) => r.id === comment.id)!;
        assert.equal(stored.updated_at?.getTime(), ms);
        previous = { etag: String(res.headers.etag), ms };
        ifMatch = previous.etag;
      }
    });

    it('an edit that waited for the lock never writes an updatedAt older than the one it found (it is not the start of its transaction)', async () => {
      const { comment } = await create('developer', 'waits');
      // The row is locked and given an updatedAt in the future, as if an edit with a later clock had just committed.
      await t.owner.query('BEGIN');
      try {
        await t.owner.query('SELECT id FROM comment WHERE id = $1 FOR UPDATE', [comment.id]);
        const future = await t.owner.query<{ updated_at: Date }>(
          `UPDATE comment SET updated_at = date_trunc('milliseconds', clock_timestamp() + interval '5 seconds')
            WHERE id = $1 RETURNING updated_at`,
          [comment.id],
        );
        const foundMs = future.rows[0]!.updated_at.getTime();
        const pending = edit('developer', comment.id, 'written after the wait').then((r) => r);
        assert.equal(await waitForLockWaiters(t, 1), true, 'the edit is queued behind the lock');
        await t.owner.query('COMMIT');
        const res = await pending;
        assert.equal(res.status, 200);
        const found = (await storedComments(t, screenId)).find((r) => r.id === comment.id)!;
        const writtenMs = Date.parse(commentOf(res).updatedAt!);
        assert.equal(found.updated_at?.getTime(), writtenMs);
        assert.ok(writtenMs > foundMs, `it is after the value it found (${writtenMs} > ${foundMs})`);
        assert.equal(res.headers.etag, `W/"${writtenMs}"`);
      } catch (error) {
        await t.owner.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  });
});
