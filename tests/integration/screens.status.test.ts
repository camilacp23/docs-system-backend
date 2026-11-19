/**
 * Module 4, PUT /screens/{id}/status (FR-14; SDD Table 50 and 61; D-53, D-62, D-88): the transitions of Table 61, the
 * order of the errors (400, 404, APPLICATION_ARCHIVED, 412, INVALID_TRANSITION, TEMPLATE_INCOMPLETE), the roles, the
 * ETag of the answer, App (OnStart), and the audit trail. The review (APPROVED) has its own file.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { insertApplication, setApplicationStatus } from '../helpers/fixtures.js';
import {
  createScreenVia,
  detailsOf,
  emptyTemplate,
  putBodyOf,
  screenOf,
  templateWith,
  type ScreenBody,
} from '../helpers/screens.js';
import { asUser } from '../helpers/users.js';

const FULL = templateWith({
  onStart: 'o',
  workingProcess: 'w',
  architecture: 'a',
  dataModel: 'd',
  requirements: 'r',
  knownIssues: 'k',
  risks: 's',
});

type Status = 'UNDOCUMENTED' | 'DRAFT' | 'IN_PROGRESS' | 'IN_REVIEW' | 'APPROVED';

/** The seven `/status` rows of Table 61. */
const ALLOWED: readonly [Status, Status][] = [
  ['UNDOCUMENTED', 'DRAFT'],
  ['DRAFT', 'UNDOCUMENTED'],
  ['DRAFT', 'IN_PROGRESS'],
  ['IN_PROGRESS', 'DRAFT'],
  ['IN_PROGRESS', 'IN_REVIEW'],
  ['IN_REVIEW', 'IN_PROGRESS'],
  ['APPROVED', 'IN_PROGRESS'],
];

describe('screens: PUT /screens/{id}/status', () => {
  let t: TestApp;
  let app: { id: number; name: string; appContextScreenId: number };

  before(async () => {
    t = await startTestApp();
    app = await insertApplication(t, { name: 'Status movers' });
  });
  after(async () => {
    await t.close();
  });

  const dev = () => asUser(t, t.users.developer.token);
  const admin = () => asUser(t, t.users.admin.token);
  const reader = () => asUser(t, t.users.reader.token);
  const move = (api: ReturnType<typeof dev>, id: number, status: string, ifMatch?: string) =>
    api.put(`/screens/${id}/status`, { status }, ifMatch);
  const count = async (sql: string, params: unknown[] = []) => (await t.owner.query(sql, params)).rowCount;

  /** A screen in the given status with the given template; the status is set directly, as the owner. */
  async function screenIn(
    status: Status,
    template = FULL,
    applicationId = app.id,
  ): Promise<{ screen: ScreenBody; etag: string }> {
    const created = await createScreenVia(dev(), applicationId, { template });
    await t.owner.query(`UPDATE screen SET documentation_status = $2::documentation_status WHERE id = $1`, [
      created.screen.id,
      status,
    ]);
    const read = await dev().get(`/screens/${created.screen.id}`);
    return { screen: screenOf(read), etag: String(read.headers.etag) };
  }

  /** The last UPDATE of the screen in `audit_log`. */
  async function lastUpdate(id: number) {
    const r = await t.owner.query<{
      actor_user_id: number | null;
      changed_fields: string[];
      old_value: { documentation_status: string };
      new_value: { documentation_status: string };
    }>(
      `SELECT actor_user_id, changed_fields, old_value, new_value FROM audit_log
        WHERE entity_type = 'screen' AND entity_id = $1 AND action = 'UPDATE' ORDER BY id DESC LIMIT 1`,
      [String(id)],
    );
    return r.rows[0]!;
  }

  describe('transitions (Table 61)', () => {
    for (const [from, to] of ALLOWED) {
      it(`${from} -> ${to}: 200 with the Screen and a new ETag, for an Administrator and a Developer`, async () => {
        for (const [who, api] of [
          ['administrator', admin()],
          ['developer', dev()],
        ] as const) {
          const { screen, etag } = await screenIn(from);
          const res = await move(api, screen.id, to, etag);
          assert.equal(res.status, 200, `${who}: ${JSON.stringify(res.body)}`);
          const body = screenOf(res);
          assert.equal(body.id, screen.id);
          assert.equal(body.documentationStatus, to);
          assert.equal(body.template.onStart, 'o');
          assert.ok(Array.isArray(body.components));
          assert.match(String(res.headers.etag), /^W\/"\d+-\d+-\d+-[0-9a-f]{8}"$/);
          assert.notEqual(res.headers.etag, etag);
          assert.equal(res.headers.etag, String((await dev().get(`/screens/${screen.id}`)).headers.etag));
        }
      });
    }

    it('any other combination, the same status included, is 422 INVALID_TRANSITION with from and to; nothing is written', async () => {
      const statuses: Status[] = ['UNDOCUMENTED', 'DRAFT', 'IN_PROGRESS', 'IN_REVIEW'];
      for (const from of [...statuses, 'APPROVED'] as Status[]) {
        const { screen, etag } = await screenIn(from);
        for (const to of statuses) {
          if (ALLOWED.some(([f, x]) => f === from && x === to)) continue;
          const auditBefore = await count(`SELECT 1 FROM audit_log`);
          const res = await move(dev(), screen.id, to, etag);
          assert.equal(res.status, 422, `${from} -> ${to}`);
          assert.equal(bodyOf(res).code, 'INVALID_TRANSITION');
          assert.equal(bodyOf(res).message, 'This screen changed status meanwhile. Reload to see its current status.');
          assert.deepEqual(detailsOf(res), { from, to });
          assert.equal(await count(`SELECT 1 FROM audit_log`), auditBefore, `${from} -> ${to}`);
        }
        const stored = screenOf(await dev().get(`/screens/${screen.id}`));
        assert.equal(stored.documentationStatus, from);
      }
    });

    it('APPROVED is not a valid body: 400 from the validator', async () => {
      const { screen } = await screenIn('IN_REVIEW');
      for (const status of ['APPROVED', 'FINISHED', '', null]) {
        const res = await move(admin(), screen.id, status as string);
        assert.equal(res.status, 400, String(status));
        assert.equal(bodyOf(res).code, 'VALIDATION_ERROR');
      }
      assert.equal((await admin().put(`/screens/${screen.id}/status`, {})).status, 400);
      assert.equal((await admin().put(`/screens/${screen.id}/status`, { status: 'DRAFT', extra: 1 })).status, 400);
    });
  });

  describe('submitting for review (TEMPLATE_INCOMPLETE)', () => {
    it('with empty fields: 422 with the missing fields in the order of Table 28 and the contract names', async () => {
      const { screen, etag } = await screenIn('IN_PROGRESS', emptyTemplate());
      const res = await move(dev(), screen.id, 'IN_REVIEW', etag);
      assert.equal(res.status, 422);
      assert.equal(bodyOf(res).code, 'TEMPLATE_INCOMPLETE');
      assert.deepEqual(detailsOf(res), {
        fields: ['onStart', 'workingProcess', 'architecture', 'dataModel', 'requirements', 'knownIssues', 'risks'],
      });
      assert.equal(
        bodyOf(res).message,
        'Complete all seven template fields to submit for review. Missing: onStart, workingProcess, architecture, dataModel, requirements, knownIssues, risks.',
      );
      assert.equal(screenOf(await dev().get(`/screens/${screen.id}`)).documentationStatus, 'IN_PROGRESS');
    });

    it('a blank field counts as missing (D-81); only the empty ones are listed, in the order of the table', async () => {
      const template = { ...FULL, risks: '   ', knownIssues: '\n\t', onStart: null, dataModel: 'ok' };
      const { screen, etag } = await screenIn('IN_PROGRESS', template);
      const res = await move(dev(), screen.id, 'IN_REVIEW', etag);
      assert.equal(res.status, 422);
      assert.deepEqual(detailsOf(res), { fields: ['onStart', 'knownIssues', 'risks'] });
      assert.equal(
        bodyOf(res).message,
        'Complete all seven template fields to submit for review. Missing: onStart, knownIssues, risks.',
      );
    });

    it('with the seven fields: 200 IN_REVIEW; the text is not trimmed or changed', async () => {
      const { screen, etag } = await screenIn('IN_PROGRESS', { ...FULL, risks: '  padded  ' });
      const res = await move(dev(), screen.id, 'IN_REVIEW', etag);
      assert.equal(res.status, 200);
      assert.equal(screenOf(res).documentationStatus, 'IN_REVIEW');
      assert.equal(screenOf(res).template.risks, '  padded  ');
    });

    it('the template is judged only when submitting: the other rows accept an empty template', async () => {
      for (const [from, to] of ALLOWED) {
        if (to === 'IN_REVIEW') continue;
        const { screen, etag } = await screenIn(from, emptyTemplate());
        assert.equal((await move(dev(), screen.id, to, etag)).status, 200, `${from} -> ${to}`);
      }
    });
  });

  describe('order of the errors: 400, 404, APPLICATION_ARCHIVED, 412, INVALID_TRANSITION, TEMPLATE_INCOMPLETE', () => {
    it('400 goes before 404: an invalid body on a missing screen is 400', async () => {
      const res = await move(dev(), 999999, 'APPROVED');
      assert.equal(res.status, 400);
    });

    it('404 for a missing screen and for an id that cannot exist; 400 for a text id', async () => {
      const missing = await move(dev(), 999999, 'DRAFT');
      assert.equal(missing.status, 404);
      assert.equal(bodyOf(missing).code, 'NOT_FOUND');
      assert.equal((await move(dev(), 2147483648, 'DRAFT')).status, 404);
      assert.equal((await move(dev(), 'abc' as unknown as number, 'DRAFT')).status, 400);
    });

    it('404 goes before 412: a missing screen with any If-Match is 404', async () => {
      assert.equal((await move(dev(), 999999, 'DRAFT', 'W/"1"')).status, 404);
    });

    it('APPLICATION_ARCHIVED goes before 412 and before INVALID_TRANSITION, for every role', async () => {
      const { screen, etag } = await screenIn('DRAFT');
      await setApplicationStatus(t, app.id, 'ARCHIVED');
      try {
        for (const api of [dev(), admin()]) {
          for (const [status, ifMatch] of [
            ['IN_PROGRESS', etag],
            ['IN_PROGRESS', 'W/"1"'],
            ['DRAFT', 'W/"1"'], // same status: would be INVALID_TRANSITION
            ['IN_REVIEW', undefined], // would be INVALID_TRANSITION too
          ] as const) {
            const res = await move(api, screen.id, status, ifMatch);
            assert.equal(res.status, 422, `${status} ${ifMatch}`);
            assert.equal(bodyOf(res).code, 'APPLICATION_ARCHIVED');
            assert.equal(detailsOf(res).applicationId, app.id);
          }
        }
        assert.equal(screenOf(await dev().get(`/screens/${screen.id}`)).documentationStatus, 'DRAFT');
      } finally {
        await setApplicationStatus(t, app.id, 'ACTIVE');
      }
    });

    it('412 goes before INVALID_TRANSITION and before TEMPLATE_INCOMPLETE, with details.currentETag', async () => {
      const { screen, etag } = await screenIn('IN_PROGRESS', emptyTemplate());
      for (const status of ['IN_PROGRESS', 'IN_REVIEW', 'DRAFT']) {
        const res = await move(dev(), screen.id, status, 'W/"1"');
        assert.equal(res.status, 412, status);
        assert.equal(bodyOf(res).code, 'PRECONDITION_FAILED');
        assert.deepEqual(detailsOf(res), { element: 'screen', currentETag: etag });
      }
    });

    it('INVALID_TRANSITION goes before TEMPLATE_INCOMPLETE: an invalid submit from DRAFT is not "incomplete"', async () => {
      const { screen, etag } = await screenIn('DRAFT', emptyTemplate());
      const res = await move(dev(), screen.id, 'IN_REVIEW', etag);
      assert.equal(res.status, 422);
      assert.equal(bodyOf(res).code, 'INVALID_TRANSITION');
      assert.deepEqual(detailsOf(res), { from: 'DRAFT', to: 'IN_REVIEW' });
    });
  });

  describe('If-Match and the ETag of the answer (D-62, D-88)', () => {
    it('the ETag of the answer chains into the next If-Match; the old one is then 412', async () => {
      const { screen, etag } = await screenIn('DRAFT');
      const first = await move(dev(), screen.id, 'IN_PROGRESS', etag);
      assert.equal(first.status, 200);
      const second = await move(dev(), screen.id, 'IN_REVIEW', String(first.headers.etag));
      assert.equal(second.status, 200);
      const stale = await move(dev(), screen.id, 'IN_PROGRESS', String(first.headers.etag));
      assert.equal(stale.status, 412);
      assert.deepEqual(detailsOf(stale), { element: 'screen', currentETag: String(second.headers.etag) });
    });

    it('If-Match is optional: without it the change is made', async () => {
      const { screen } = await screenIn('DRAFT');
      assert.equal((await move(dev(), screen.id, 'IN_PROGRESS')).status, 200);
    });

    it('the status change moves the ETag used by PUT /screens/{id}', async () => {
      const { screen, etag } = await screenIn('DRAFT');
      const moved = await move(dev(), screen.id, 'IN_PROGRESS', etag);
      const stale = await dev().put(`/screens/${screen.id}`, putBodyOf(screen), etag);
      assert.equal(stale.status, 412);
      const fresh = await dev().put(`/screens/${screen.id}`, putBodyOf(screen), String(moved.headers.etag));
      assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
      assert.equal(screenOf(fresh).documentationStatus, 'IN_PROGRESS');
    });
  });

  describe('roles', () => {
    it('401 without a token; 403 for a Reader with requiredRoles; nothing is written', async () => {
      const { screen, etag } = await screenIn('DRAFT');
      assert.equal(
        (await t.http.put(`/api/v1/screens/${screen.id}/status`).send({ status: 'IN_PROGRESS' })).status,
        401,
      );
      const auditBefore = await count(`SELECT 1 FROM audit_log`);
      const res = await move(reader(), screen.id, 'IN_PROGRESS', etag);
      assert.equal(res.status, 403);
      assert.equal(bodyOf(res).code, 'FORBIDDEN');
      assert.deepEqual(bodyOf(res).details.requiredRoles, ['ADMINISTRATOR', 'DEVELOPER']);
      assert.equal(await count(`SELECT 1 FROM audit_log`), auditBefore);
      assert.equal(screenOf(await dev().get(`/screens/${screen.id}`)).documentationStatus, 'DRAFT');
    });
  });

  describe('App (OnStart)', () => {
    it('follows the same workflow (SDD Section 9): it can be submitted once its template is complete', async () => {
      const id = app.appContextScreenId;
      const first = await move(dev(), id, 'DRAFT');
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(screenOf(first).isAppContext, true);
      const second = await move(dev(), id, 'IN_PROGRESS', String(first.headers.etag));
      assert.equal(second.status, 200);
      const incomplete = await move(dev(), id, 'IN_REVIEW', String(second.headers.etag));
      assert.equal(incomplete.status, 422);
      assert.equal(bodyOf(incomplete).code, 'TEMPLATE_INCOMPLETE');
      const put = await dev().put(
        `/screens/${id}`,
        putBodyOf(screenOf(await dev().get(`/screens/${id}`)), { template: FULL }),
        String(second.headers.etag),
      );
      assert.equal(put.status, 200, JSON.stringify(put.body));
      const submitted = await move(dev(), id, 'IN_REVIEW', String(put.headers.etag));
      assert.equal(submitted.status, 200);
      assert.equal(screenOf(submitted).documentationStatus, 'IN_REVIEW');
      assert.equal(screenOf(submitted).name, 'App (OnStart)');
    });
  });

  describe('editing while in review (D-53)', () => {
    it('SCREEN_IN_REVIEW blocks the PUT; the withdraw (IN_REVIEW -> IN_PROGRESS) makes it editable again', async () => {
      const { screen, etag } = await screenIn('IN_PROGRESS');
      const submitted = await move(dev(), screen.id, 'IN_REVIEW', etag);
      assert.equal(submitted.status, 200);
      const blocked = await dev().put(
        `/screens/${screen.id}`,
        putBodyOf(screen, { template: { ...FULL, risks: 'changed' } }),
        String(submitted.headers.etag),
      );
      assert.equal(blocked.status, 422);
      assert.equal(bodyOf(blocked).code, 'SCREEN_IN_REVIEW');

      const withdrawn = await move(dev(), screen.id, 'IN_PROGRESS', String(submitted.headers.etag));
      assert.equal(withdrawn.status, 200);
      const edited = await dev().put(
        `/screens/${screen.id}`,
        putBodyOf(screen, { template: { ...FULL, risks: 'changed' } }),
        String(withdrawn.headers.etag),
      );
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
      assert.equal(screenOf(edited).template.risks, 'changed');
      assert.equal(screenOf(edited).documentationStatus, 'IN_PROGRESS');
    });

    it('reopening an APPROVED screen (APPROVED -> IN_PROGRESS) makes it editable', async () => {
      const { screen, etag } = await screenIn('APPROVED');
      const reopened = await move(dev(), screen.id, 'IN_PROGRESS', etag);
      assert.equal(reopened.status, 200);
      const edited = await dev().put(
        `/screens/${screen.id}`,
        putBodyOf(screen, { miroLink: 'https://miro.com/x' }),
        String(reopened.headers.etag),
      );
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
    });
  });

  describe('audit', () => {
    it('the change is one UPDATE of screen with the old and new status, the changed field and the actor', async () => {
      const { screen, etag } = await screenIn('DRAFT');
      const res = await move(dev(), screen.id, 'IN_PROGRESS', etag);
      assert.equal(res.status, 200);
      const row = await lastUpdate(screen.id);
      assert.equal(row.actor_user_id, t.users.developer.id);
      assert.deepEqual(row.changed_fields, ['documentation_status']);
      assert.equal(row.old_value.documentation_status, 'DRAFT');
      assert.equal(row.new_value.documentation_status, 'IN_PROGRESS');
    });

    it('a status change does not create a business event or a comment (D-30)', async () => {
      const { screen, etag } = await screenIn('IN_PROGRESS');
      assert.equal((await move(admin(), screen.id, 'IN_REVIEW', etag)).status, 200);
      assert.equal(
        await count(`SELECT 1 FROM audit_log WHERE action = 'EVENT' AND entity_id = $1`, [String(screen.id)]),
        0,
      );
      assert.equal(await count(`SELECT 1 FROM comment WHERE screen_id = $1`, [screen.id]), 0);
    });
  });
});
