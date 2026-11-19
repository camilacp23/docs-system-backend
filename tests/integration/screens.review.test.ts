/**
 * Module 4, POST /screens/{id}/review (FR-24; SDD Table 52 and 61; CP-11, D-30, D-56, D-88): APPROVE and RETURN, the
 * review comment, the business event, the order of the errors (400, 404, APPLICATION_ARCHIVED, NOT_IN_REVIEW,
 * COMMENT_REQUIRED), the roles and the audit trail. All of it is written in one transaction.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bearer, bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { insertApplication, setApplicationStatus } from '../helpers/fixtures.js';
import {
  createScreenInStatus,
  detailsOf,
  fullTemplate,
  putBodyOf,
  screenOf,
  templateWith,
} from '../helpers/screens.js';
import { asUser } from '../helpers/users.js';

type Status = 'UNDOCUMENTED' | 'DRAFT' | 'IN_PROGRESS' | 'IN_REVIEW' | 'APPROVED';

describe('screens: POST /screens/{id}/review', () => {
  let t: TestApp;
  let app: { id: number; name: string; appContextScreenId: number };

  before(async () => {
    t = await startTestApp();
    app = await insertApplication(t, { name: 'Screen reviewers' });
  });
  after(async () => {
    await t.close();
  });

  const dev = () => asUser(t, t.users.developer.token);
  const admin = () => asUser(t, t.users.admin.token);
  const reader = () => asUser(t, t.users.reader.token);
  const review = (api: ReturnType<typeof admin>, id: number, body: object) => api.post(`/screens/${id}/review`, body);
  const inStatus = (status: Status, template = fullTemplate()) =>
    createScreenInStatus(t, dev(), app.id, status, template);
  const count = async (sql: string, params: unknown[] = []) => (await t.owner.query(sql, params)).rowCount;

  const commentsOf = async (screenId: number) =>
    (
      await t.owner.query<{ id: number; user_id: number; text: string; review_decision: string | null }>(
        `SELECT id, user_id, text, review_decision FROM comment WHERE screen_id = $1 ORDER BY id`,
        [screenId],
      )
    ).rows;
  const eventsOf = async (screenId: number) =>
    (
      await t.owner.query<{
        actor_user_id: number | null;
        db_role: string;
        event_name: string;
        entity_type: string;
        entity_id: string;
        entity_label: string;
        application_id: number;
        new_value: { from: string; to: string; commentId: number | null };
      }>(
        `SELECT actor_user_id, db_role, event_name, entity_type, entity_id, entity_label, application_id, new_value
           FROM audit_log WHERE action = 'EVENT' AND entity_type = 'screen' AND entity_id = $1 ORDER BY id`,
        [String(screenId)],
      )
    ).rows;
  const statusOf = async (id: number) => screenOf(await dev().get(`/screens/${id}`)).documentationStatus;
  /** A fingerprint of everything a review writes, to prove a refused review wrote nothing. */
  const footprint = async (id: number) =>
    JSON.stringify([
      await count(`SELECT 1 FROM audit_log`),
      await commentsOf(id),
      await eventsOf(id),
      await statusOf(id),
    ]);

  describe('APPROVE', () => {
    it('without a comment: 200 APPROVED with the Screen and a new ETag, no comment, one event with commentId null', async () => {
      const { screen, etag } = await inStatus('IN_REVIEW');
      const res = await review(admin(), screen.id, { decision: 'APPROVE' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const body = screenOf(res);
      assert.equal(body.id, screen.id);
      assert.equal(body.documentationStatus, 'APPROVED');
      assert.equal(body.commentCount, 0);
      assert.match(String(res.headers.etag), /^W\/"\d+-\d+-\d+-[0-9a-f]{8}"$/);
      assert.notEqual(res.headers.etag, etag);
      assert.equal(res.headers.etag, String((await dev().get(`/screens/${screen.id}`)).headers.etag));

      assert.deepEqual(await commentsOf(screen.id), []);
      const events = await eventsOf(screen.id);
      assert.equal(events.length, 1);
      assert.deepEqual(events[0], {
        actor_user_id: t.users.admin.id,
        db_role: 'docs_app',
        event_name: 'DOCUMENTATION_APPROVED',
        entity_type: 'screen',
        entity_id: String(screen.id),
        entity_label: screen.name,
        application_id: app.id,
        new_value: { from: 'IN_REVIEW', to: 'APPROVED', commentId: null },
      });
    });

    it('with a comment: a review comment APPROVE by the caller, text as received, id in the event, counted in the Screen', async () => {
      const { screen } = await inStatus('IN_REVIEW');
      const text = '  Looks good.\n  Thanks  ';
      const res = await review(admin(), screen.id, { decision: 'APPROVE', comment: text });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(screenOf(res).documentationStatus, 'APPROVED');
      assert.equal(screenOf(res).commentCount, 1);

      const comments = await commentsOf(screen.id);
      assert.equal(comments.length, 1);
      assert.equal(comments[0]!.text, text);
      assert.equal(comments[0]!.review_decision, 'APPROVE');
      assert.equal(comments[0]!.user_id, t.users.admin.id);
      const events = await eventsOf(screen.id);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.event_name, 'DOCUMENTATION_APPROVED');
      assert.deepEqual(events[0]!.new_value, { from: 'IN_REVIEW', to: 'APPROVED', commentId: comments[0]!.id });
    });

    it('a comment without content (null, empty, only spaces) creates no comment; the screen is still approved', async () => {
      for (const comment of [null, '', '   ', '\n\t ']) {
        const { screen } = await inStatus('IN_REVIEW');
        const res = await review(admin(), screen.id, { decision: 'APPROVE', comment });
        assert.equal(res.status, 200, `${JSON.stringify(comment)}: ${JSON.stringify(res.body)}`);
        assert.equal(screenOf(res).documentationStatus, 'APPROVED');
        assert.deepEqual(await commentsOf(screen.id), [], JSON.stringify(comment));
        assert.equal((await eventsOf(screen.id))[0]!.new_value.commentId, null, JSON.stringify(comment));
      }
    });

    it('an approved screen that is edited returns to IN_PROGRESS (D-81), and the review comment stays', async () => {
      const { screen } = await inStatus('IN_REVIEW');
      const approved = await review(admin(), screen.id, { decision: 'APPROVE', comment: 'ok' });
      const edited = await dev().put(
        `/screens/${screen.id}`,
        putBodyOf(screen, { miroLink: 'https://miro.com/x' }),
        String(approved.headers.etag),
      );
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      assert.equal(screenOf(edited).documentationStatus, 'IN_PROGRESS');
      assert.equal((await commentsOf(screen.id)).length, 1);
    });
  });

  describe('RETURN', () => {
    it('with a comment: 200 IN_PROGRESS, a review comment RETURN by the caller, one DOCUMENTATION_RETURNED event', async () => {
      const { screen, etag } = await inStatus('IN_REVIEW');
      const text = ' Missing the risks of the gallery. ';
      const res = await review(admin(), screen.id, { decision: 'RETURN', comment: text });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(screenOf(res).documentationStatus, 'IN_PROGRESS');
      assert.equal(screenOf(res).commentCount, 1);
      assert.notEqual(res.headers.etag, etag);

      const comments = await commentsOf(screen.id);
      assert.deepEqual(
        comments.map((c) => [c.text, c.review_decision, c.user_id]),
        [[text, 'RETURN', t.users.admin.id]],
      );
      const events = await eventsOf(screen.id);
      assert.equal(events.length, 1);
      assert.equal(events[0]!.event_name, 'DOCUMENTATION_RETURNED');
      assert.equal(events[0]!.actor_user_id, t.users.admin.id);
      assert.deepEqual(events[0]!.new_value, { from: 'IN_REVIEW', to: 'IN_PROGRESS', commentId: comments[0]!.id });
    });

    it('a comment of only spaces is 422 COMMENT_REQUIRED and nothing is written', async () => {
      const { screen } = await inStatus('IN_REVIEW');
      const before = await footprint(screen.id);
      for (const comment of ['   ', '\n\t ']) {
        const res = await review(admin(), screen.id, { decision: 'RETURN', comment });
        assert.equal(res.status, 422, JSON.stringify(comment));
        assert.equal(bodyOf(res).code, 'COMMENT_REQUIRED');
        assert.equal(bodyOf(res).message, 'Write a comment: it is required to return the documentation.');
        assert.equal((res.body as { details: unknown }).details ?? null, null);
      }
      assert.equal(await footprint(screen.id), before);
      assert.equal(await statusOf(screen.id), 'IN_REVIEW');
    });

    it('without comment, with "" or with null the VALIDATOR answers 400 (not COMMENT_REQUIRED); nothing is written', async () => {
      const { screen } = await inStatus('IN_REVIEW');
      const before = await footprint(screen.id);
      for (const body of [
        { decision: 'RETURN' },
        { decision: 'RETURN', comment: '' },
        { decision: 'RETURN', comment: null },
      ]) {
        const res = await review(admin(), screen.id, body);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.equal(bodyOf(res).code, 'VALIDATION_ERROR', JSON.stringify(body));
        assert.ok(bodyOf(res).details.fields.length > 0, JSON.stringify(body));
      }
      assert.equal(await footprint(screen.id), before);
    });

    it('a returned screen can be edited again (D-53) and submitted again', async () => {
      const { screen } = await inStatus('IN_REVIEW');
      const returned = await review(admin(), screen.id, { decision: 'RETURN', comment: 'More detail, please.' });
      const edited = await dev().put(
        `/screens/${screen.id}`,
        putBodyOf(screen, { template: { ...fullTemplate(), risks: 'detailed risks' } }),
        String(returned.headers.etag),
      );
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      const submitted = await dev().put(
        `/screens/${screen.id}/status`,
        { status: 'IN_REVIEW' },
        String(edited.headers.etag),
      );
      assert.equal(submitted.status, 200);
      const approved = await review(admin(), screen.id, { decision: 'APPROVE' });
      assert.equal(approved.status, 200);
      assert.deepEqual(
        (await eventsOf(screen.id)).map((e) => e.event_name),
        ['DOCUMENTATION_RETURNED', 'DOCUMENTATION_APPROVED'],
      );
    });
  });

  describe('the request body (400, validator)', () => {
    it('a missing or unknown decision, extra properties and a missing body are 400; nothing is written', async () => {
      const { screen } = await inStatus('IN_REVIEW');
      const before = await footprint(screen.id);
      for (const body of [
        {},
        { decision: 'MAYBE' },
        { decision: 'approve' },
        { comment: 'x' },
        { decision: 'APPROVE', extra: true },
        { decision: 'RETURN', comment: 'x', extra: true },
        { decision: 'APPROVE', comment: 'x'.repeat(4001) },
        { decision: 'RETURN', comment: 'x'.repeat(4001) },
      ]) {
        const res = await review(admin(), screen.id, body);
        assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
        assert.equal(bodyOf(res).code, 'VALIDATION_ERROR');
      }
      assert.equal(
        (await t.http.post(`/api/v1/screens/${screen.id}/review`).set('Authorization', bearer(t.users.admin.token)))
          .status,
        400,
      );
      assert.equal(await footprint(screen.id), before);
    });

    it('a comment of exactly 4000 characters is accepted', async () => {
      const { screen } = await inStatus('IN_REVIEW');
      const res = await review(admin(), screen.id, { decision: 'RETURN', comment: 'x'.repeat(4000) });
      assert.equal(res.status, 200);
      assert.equal((await commentsOf(screen.id))[0]!.text.length, 4000);
    });
  });

  describe('order of the errors: 400, 404, APPLICATION_ARCHIVED, NOT_IN_REVIEW, COMMENT_REQUIRED', () => {
    it('400 goes before 404: an invalid body on a missing screen is 400', async () => {
      assert.equal((await review(admin(), 999999, { decision: 'RETURN' })).status, 400);
    });

    it('404 for a missing screen and for an id that cannot exist; 400 for a text id', async () => {
      const missing = await review(admin(), 999999, { decision: 'APPROVE' });
      assert.equal(missing.status, 404);
      assert.equal(bodyOf(missing).code, 'NOT_FOUND');
      assert.equal((await review(admin(), 2147483648, { decision: 'APPROVE' })).status, 404);
      assert.equal((await review(admin(), 'abc' as unknown as number, { decision: 'APPROVE' })).status, 400);
    });

    it('APPLICATION_ARCHIVED goes before NOT_IN_REVIEW and COMMENT_REQUIRED, and nothing is written', async () => {
      const inReview = await inStatus('IN_REVIEW');
      const draft = await inStatus('DRAFT');
      await setApplicationStatus(t, app.id, 'ARCHIVED');
      try {
        for (const [id, body] of [
          [inReview.screen.id, { decision: 'APPROVE' }],
          [inReview.screen.id, { decision: 'RETURN', comment: '  ' }],
          [draft.screen.id, { decision: 'RETURN', comment: '  ' }],
          [draft.screen.id, { decision: 'APPROVE' }],
        ] as const) {
          const res = await review(admin(), id, body);
          assert.equal(res.status, 422, JSON.stringify(body));
          assert.equal(bodyOf(res).code, 'APPLICATION_ARCHIVED');
          assert.equal(detailsOf(res).applicationId, app.id);
        }
        assert.equal(await statusOf(inReview.screen.id), 'IN_REVIEW');
        assert.deepEqual(await commentsOf(inReview.screen.id), []);
        assert.deepEqual(await eventsOf(inReview.screen.id), []);
      } finally {
        await setApplicationStatus(t, app.id, 'ACTIVE');
      }
    });

    it('NOT_IN_REVIEW for every other status and both decisions, with no details; it goes before COMMENT_REQUIRED', async () => {
      for (const status of ['UNDOCUMENTED', 'DRAFT', 'IN_PROGRESS', 'APPROVED'] as const) {
        const { screen } = await inStatus(status);
        const before = await footprint(screen.id);
        for (const body of [
          { decision: 'APPROVE' },
          { decision: 'RETURN', comment: 'x' },
          { decision: 'RETURN', comment: '  ' },
        ]) {
          const res = await review(admin(), screen.id, body);
          assert.equal(res.status, 422, `${status} ${JSON.stringify(body)}`);
          assert.equal(bodyOf(res).code, 'NOT_IN_REVIEW');
          assert.equal(bodyOf(res).message, 'This screen is no longer in review. Reload to see its status.');
          assert.equal((res.body as { details: unknown }).details ?? null, null);
        }
        assert.equal(await footprint(screen.id), before, status);
      }
    });

    it('a second decision on the same screen is NOT_IN_REVIEW', async () => {
      const { screen } = await inStatus('IN_REVIEW');
      assert.equal((await review(admin(), screen.id, { decision: 'APPROVE' })).status, 200);
      const again = await review(admin(), screen.id, { decision: 'RETURN', comment: 'too late' });
      assert.equal(again.status, 422);
      assert.equal(bodyOf(again).code, 'NOT_IN_REVIEW');
      assert.equal((await eventsOf(screen.id)).length, 1);
    });
  });

  describe('If-Match', () => {
    it('the contract declares none for /review: a stale If-Match is ignored (no 412)', async () => {
      const { screen } = await inStatus('IN_REVIEW');
      const res = await t.http
        .post(`/api/v1/screens/${screen.id}/review`)
        .set('Authorization', bearer(t.users.admin.token))
        .set('If-Match', 'W/"1"')
        .send({ decision: 'APPROVE' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });
  });

  describe('roles', () => {
    it('401 without a token; 403 with requiredRoles for a Developer and a Reader; nothing is written', async () => {
      const { screen } = await inStatus('IN_REVIEW');
      assert.equal(
        (await t.http.post(`/api/v1/screens/${screen.id}/review`).send({ decision: 'APPROVE' })).status,
        401,
      );
      const before = await footprint(screen.id);
      for (const api of [dev(), reader()]) {
        for (const body of [{ decision: 'APPROVE' }, { decision: 'RETURN', comment: 'no' }]) {
          const res = await review(api, screen.id, body);
          assert.equal(res.status, 403, JSON.stringify(body));
          assert.equal(bodyOf(res).code, 'FORBIDDEN');
          assert.deepEqual(bodyOf(res).details.requiredRoles, ['ADMINISTRATOR']);
        }
      }
      assert.equal(await footprint(screen.id), before);
    });

    it('the author of the screen does not matter: a Developer cannot approve their own screen', async () => {
      const { screen } = await inStatus('IN_REVIEW');
      assert.equal(screen.author.id, t.users.developer.id);
      assert.equal((await review(dev(), screen.id, { decision: 'APPROVE' })).status, 403);
    });
  });

  describe('App (OnStart)', () => {
    it('follows the same workflow: it is submitted and then approved by an Administrator', async () => {
      const id = app.appContextScreenId;
      const put = await dev().put(
        `/screens/${id}`,
        putBodyOf(screenOf(await dev().get(`/screens/${id}`)), { template: fullTemplate() }),
      );
      assert.equal(put.status, 200, JSON.stringify(put.body));
      const toProgress = await dev().put(`/screens/${id}/status`, { status: 'IN_PROGRESS' });
      assert.equal(toProgress.status, 200, JSON.stringify(toProgress.body));
      assert.equal((await dev().put(`/screens/${id}/status`, { status: 'IN_REVIEW' })).status, 200);
      const res = await review(admin(), id, { decision: 'APPROVE', comment: 'App documented.' });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(screenOf(res).isAppContext, true);
      assert.equal(screenOf(res).documentationStatus, 'APPROVED');
      assert.equal((await eventsOf(id))[0]!.entity_label, 'App (OnStart)');
    });
  });

  describe('audit', () => {
    it('the status change is an UPDATE of screen with old and new status; the review comment is a CREATE of comment', async () => {
      const { screen } = await inStatus('IN_REVIEW');
      const res = await review(admin(), screen.id, { decision: 'RETURN', comment: 'Please add the data model.' });
      assert.equal(res.status, 200);

      const update = (
        await t.owner.query<{
          actor_user_id: number;
          changed_fields: string[];
          old_value: { documentation_status: string };
          new_value: { documentation_status: string };
        }>(
          `SELECT actor_user_id, changed_fields, old_value, new_value FROM audit_log
            WHERE entity_type = 'screen' AND entity_id = $1 AND action = 'UPDATE' ORDER BY id DESC LIMIT 1`,
          [String(screen.id)],
        )
      ).rows[0]!;
      assert.equal(update.actor_user_id, t.users.admin.id);
      assert.deepEqual(update.changed_fields, ['documentation_status']);
      assert.equal(update.old_value.documentation_status, 'IN_REVIEW');
      assert.equal(update.new_value.documentation_status, 'IN_PROGRESS');

      const comment = (await commentsOf(screen.id))[0]!;
      const created = (
        await t.owner.query<{
          actor_user_id: number;
          application_id: number;
          new_value: { screen_id: number; user_id: number; text: string; review_decision: string };
        }>(
          `SELECT actor_user_id, application_id, new_value FROM audit_log
            WHERE entity_type = 'comment' AND entity_id = $1 AND action = 'CREATE'`,
          [String(comment.id)],
        )
      ).rows;
      assert.equal(created.length, 1);
      assert.equal(created[0]!.actor_user_id, t.users.admin.id);
      assert.equal(created[0]!.application_id, app.id);
      assert.equal(created[0]!.new_value.review_decision, 'RETURN');
      assert.equal(created[0]!.new_value.text, 'Please add the data model.');
      assert.equal(created[0]!.new_value.user_id, t.users.admin.id);
    });

    it('a refused review leaves no row in audit_log, comment or events (one transaction)', async () => {
      const { screen } = await inStatus('IN_PROGRESS');
      const before = await footprint(screen.id);
      assert.equal((await review(admin(), screen.id, { decision: 'RETURN', comment: 'x' })).status, 422);
      assert.equal(await footprint(screen.id), before);
    });

    it('only the review writes review_decision: the screen template and status rules are untouched by a RETURN', async () => {
      const template = templateWith({ onStart: 'only this' });
      const { screen } = await inStatus('IN_REVIEW', template);
      const res = await review(admin(), screen.id, { decision: 'RETURN', comment: 'fill the rest' });
      assert.deepEqual(screenOf(res).template, template);
    });
  });
});
