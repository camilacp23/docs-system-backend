/**
 * Where a variable is created inside its origin screen (D-134): the optional `originUsedIn` of `POST` and `PUT
 * /variables`, how a screen shows it in its `origin` row, and that the `origin` row itself (the marker of the
 * origin) is never touched by it.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { assertConformsToContract } from '../helpers/contractResponse.js';
import {
  deleteScreen,
  insertApplication,
  insertScreen,
  insertVariable,
  setApplicationStatus,
} from '../helpers/fixtures.js';
import { createScreenVia, putBodyOf as screenPut, screenOf } from '../helpers/screens.js';
import { asUser } from '../helpers/users.js';
import {
  createBodyOf,
  dependenciesOf,
  detailsOf,
  putBodyOf,
  variableOf,
  variablesPageOf,
} from '../helpers/variables.js';

type AuditRow = { action: string; changed_fields: string[] | null };

describe('variables: originUsedIn (D-134)', () => {
  let t: TestApp;
  let app: { id: number; name: string };
  let s1: { id: number; name: string };
  let s2: { id: number; name: string };

  before(async () => {
    t = await startTestApp();
    app = await insertApplication(t, { name: 'Origin text app' });
    s1 = await insertScreen(t, app.id, { name: 'Alta' });
    s2 = await insertScreen(t, app.id, { name: 'Baja' });
  });
  after(async () => {
    await t.close();
  });

  const admin = () => asUser(t, t.users.admin.token);
  const dev = () => asUser(t, t.users.developer.token);
  const reader = () => asUser(t, t.users.reader.token);

  async function create(over: Record<string, unknown> = {}) {
    const res = await dev().post('/variables', createBodyOf(app.id, over));
    if (res.status !== 201) throw new Error(`fixture failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { variable: variableOf(res), etag: String(res.headers.etag) };
  }
  const read = async (id: number) => {
    const res = await admin().get(`/variables/${id}`);
    return { variable: variableOf(res), etag: String(res.headers.etag) };
  };
  const readScreen = async (id: number) => {
    const res = await admin().get(`/screens/${id}`);
    return { screen: screenOf(res), etag: String(res.headers.etag) };
  };
  const columnOf = async (id: number): Promise<string | null> =>
    (await t.owner.query<{ v: string | null }>('SELECT origin_used_in AS v FROM variable WHERE id = $1', [id])).rows[0]!
      .v;
  const auditOf = async (table: string, id: number): Promise<AuditRow[]> =>
    (
      await t.owner.query<AuditRow>(
        'SELECT action, changed_fields FROM audit_log WHERE entity_type = $1 AND entity_id = $2 ORDER BY id',
        [table, String(id)],
      )
    ).rows;
  const variableCount = async (): Promise<number> =>
    Number((await t.owner.query<{ n: string }>('SELECT count(*) AS n FROM variable')).rows[0]!.n);

  describe('create', () => {
    it('stores and returns it, and the origin row of the screen keeps being the marker', async () => {
      const res = await dev().post(
        '/variables',
        createBodyOf(app.id, { originScreenId: s1.id, originUsedIn: 'btnGuardar.OnSelect' }),
      );
      assert.equal(res.status, 201, JSON.stringify(res.body));
      await assertConformsToContract(res);
      const v = variableOf(res);
      assert.equal(v.originUsedIn, 'btnGuardar.OnSelect');
      assert.equal(v.originScreen?.id, s1.id);
      assert.equal(await columnOf(v.id), 'btnGuardar.OnSelect');

      const { screen } = await readScreen(s1.id);
      const origin = screen.variableLinks.filter((l) => l.variable.id === v.id);
      assert.deepEqual(
        origin.map((l) => [l.usedIn, l.accessMode, l.isOrigin, l.originUsedIn]),
        [['origin', 'WRITE', true, 'btnGuardar.OnSelect']],
      );
    });

    it('is null when it is absent or null, with or without an origin screen', async () => {
      assert.equal((await create({ originScreenId: s1.id })).variable.originUsedIn, null);
      assert.equal((await create({ originScreenId: s1.id, originUsedIn: null })).variable.originUsedIn, null);
      assert.equal((await create({})).variable.originUsedIn, null);
      assert.equal((await create({ originUsedIn: null })).variable.originUsedIn, null);
    });

    it('without an origin screen it is a 400 on the field, and nothing is written', async () => {
      const before = await variableCount();
      const res = await dev().post('/variables', createBodyOf(app.id, { originUsedIn: 'OnVisible' }));
      assert.equal(res.status, 400);
      assert.equal(bodyOf(res).code, 'VALIDATION_ERROR');
      assert.deepEqual(detailsOf(res), {
        fields: [
          { field: 'originUsedIn', rule: 'requires', message: 'Choose the origin screen first, or leave this empty.' },
        ],
      });
      assert.equal(await variableCount(), before);
    });

    it('has the format of usedIn: not "origin", not blank, not longer than 200, a string', async () => {
      const bad: unknown[] = ['origin', '', '   ', 'two words', '1abc', 'a'.repeat(201), 5, true, {}];
      for (const value of bad) {
        const res = await dev().post(
          '/variables',
          createBodyOf(app.id, { originScreenId: s1.id, originUsedIn: value }),
        );
        assert.equal(res.status, 400, `${JSON.stringify(value)} -> ${res.status}`);
        assert.equal(bodyOf(res).code, 'VALIDATION_ERROR');
      }
      const longest = `a${'b'.repeat(199)}`;
      const ok = await dev().post('/variables', createBodyOf(app.id, { originScreenId: s1.id, originUsedIn: longest }));
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      assert.equal(variableOf(ok).originUsedIn, longest);
    });

    it('a viewer cannot write it (403)', async () => {
      const res = await reader().post(
        '/variables',
        createBodyOf(app.id, { originScreenId: s1.id, originUsedIn: 'OnVisible' }),
      );
      assert.equal(res.status, 403);
    });
  });

  describe('update', () => {
    it('changes it, moves the ETag, is audited, and leaves the origin row exactly as it was', async () => {
      const { variable, etag } = await create({ originScreenId: s1.id, originUsedIn: 'OnVisible' });
      const link = (await readScreen(s1.id)).screen.variableLinks.find((l) => l.variable.id === variable.id)!;
      const linkAuditBefore = await auditOf('screen_variable', link.id);

      const res = await dev().put(
        `/variables/${variable.id}`,
        putBodyOf(variable, { originUsedIn: 'btnGuardar.OnSelect' }),
        etag,
      );
      assert.equal(res.status, 200, JSON.stringify(res.body));
      await assertConformsToContract(res);
      assert.equal(variableOf(res).originUsedIn, 'btnGuardar.OnSelect');
      assert.notEqual(String(res.headers.etag), etag, 'the ETag follows the change');
      assert.equal(await columnOf(variable.id), 'btnGuardar.OnSelect');

      const audit = await auditOf('variable', variable.id);
      assert.equal(audit.at(-1)?.action, 'UPDATE');
      assert.equal(audit.at(-1)?.changed_fields?.includes('origin_used_in'), true);

      const after = (await readScreen(s1.id)).screen.variableLinks.find((l) => l.variable.id === variable.id)!;
      assert.deepEqual(
        [after.id, after.usedIn, after.accessMode, after.isOrigin, after.originUsedIn],
        [link.id, 'origin', 'WRITE', true, 'btnGuardar.OnSelect'],
      );
      assert.deepEqual(await auditOf('screen_variable', link.id), linkAuditBefore, 'the origin row is not rewritten');
    });

    it('an update that changes nothing writes nothing and keeps the ETag', async () => {
      const { variable, etag } = await create({ originScreenId: s1.id, originUsedIn: 'OnVisible' });
      const before = await auditOf('variable', variable.id);
      const res = await dev().put(`/variables/${variable.id}`, putBodyOf(variable), etag);
      assert.equal(res.status, 200);
      assert.equal(String(res.headers.etag), etag);
      assert.equal(variableOf(res).originUsedIn, 'OnVisible');
      assert.deepEqual(await auditOf('variable', variable.id), before);
    });

    it('PUT replaces: an omitted or null value clears it', async () => {
      const first = await create({ originScreenId: s1.id, originUsedIn: 'OnVisible' });
      const withoutField: Record<string, unknown> = { ...putBodyOf(first.variable) };
      delete withoutField.originUsedIn;
      const cleared = await dev().put(`/variables/${first.variable.id}`, withoutField, first.etag);
      assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
      assert.equal(variableOf(cleared).originUsedIn, null);
      assert.equal(await columnOf(first.variable.id), null);

      const second = await create({ originScreenId: s1.id, originUsedIn: 'OnVisible' });
      const nulled = await dev().put(
        `/variables/${second.variable.id}`,
        putBodyOf(second.variable, { originUsedIn: null }),
        second.etag,
      );
      assert.equal(variableOf(nulled).originUsedIn, null);
      const { screen } = await readScreen(s1.id);
      const row = screen.variableLinks.find((l) => l.variable.id === second.variable.id)!;
      assert.deepEqual([row.usedIn, row.isOrigin, row.originUsedIn], ['origin', true, null]);
    });

    it('without an origin screen it is a 400 and the variable is left as it was', async () => {
      const { variable, etag } = await create({ originScreenId: s1.id, originUsedIn: 'OnVisible' });
      const res = await dev().put(
        `/variables/${variable.id}`,
        putBodyOf(variable, { originScreenId: null, originUsedIn: 'OnVisible' }),
        etag,
      );
      assert.equal(res.status, 400);
      assert.equal((detailsOf(res).fields as { field: string }[])[0]!.field, 'originUsedIn');
      assert.equal((await read(variable.id)).variable.originScreen?.id, s1.id);
      assert.equal(await columnOf(variable.id), 'OnVisible');
    });

    it('removing the origin screen clears it; setting a new origin screen with a new value stores it', async () => {
      const { variable, etag } = await create({ originScreenId: s1.id, originUsedIn: 'OnVisible' });
      const removed = await dev().put(
        `/variables/${variable.id}`,
        putBodyOf(variable, { originScreenId: null, originUsedIn: null }),
        etag,
      );
      assert.equal(removed.status, 200, JSON.stringify(removed.body));
      assert.equal(variableOf(removed).originScreen, null);
      assert.equal(variableOf(removed).originUsedIn, null);
      assert.equal(await columnOf(variable.id), null);

      const moved = await dev().put(
        `/variables/${variable.id}`,
        putBodyOf(variableOf(removed), { originScreenId: s2.id, originUsedIn: 'OnStart' }),
        String(removed.headers.etag),
      );
      assert.equal(moved.status, 200, JSON.stringify(moved.body));
      assert.equal(variableOf(moved).originUsedIn, 'OnStart');
      const old = (await readScreen(s1.id)).screen.variableLinks.filter((l) => l.variable.id === variable.id);
      const now = (await readScreen(s2.id)).screen.variableLinks.filter((l) => l.variable.id === variable.id);
      assert.deepEqual(old, [], 'the origin row of the old screen is gone');
      assert.deepEqual(
        now.map((l) => [l.usedIn, l.isOrigin, l.originUsedIn]),
        [['origin', true, 'OnStart']],
      );
    });

    it('moving the origin screen keeps the value when the body sends it', async () => {
      const { variable, etag } = await create({ originScreenId: s1.id, originUsedIn: 'OnVisible' });
      const res = await dev().put(`/variables/${variable.id}`, putBodyOf(variable, { originScreenId: s2.id }), etag);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(variableOf(res).originUsedIn, 'OnVisible');
    });

    it('a stale If-Match is 412 and nothing changes; an archived application is 422', async () => {
      const { variable, etag } = await create({ originScreenId: s1.id, originUsedIn: 'OnVisible' });
      const first = await dev().put(
        `/variables/${variable.id}`,
        putBodyOf(variable, { originUsedIn: 'OnStart' }),
        etag,
      );
      assert.equal(first.status, 200);
      const stale = await dev().put(`/variables/${variable.id}`, putBodyOf(variable, { originUsedIn: 'x.Y' }), etag);
      assert.equal(stale.status, 412);
      assert.equal(await columnOf(variable.id), 'OnStart');

      const archivedApp = await insertApplication(t, { name: 'Archived origin text' });
      const screen = await insertScreen(t, archivedApp.id, { name: 'Vieja' });
      const old = await insertVariable(t, archivedApp.id, {
        name: 'gOld',
        originScreenId: screen.id,
        originUsedIn: 'OnVisible',
      });
      const current = await read(old.id);
      await setApplicationStatus(t, archivedApp.id, 'ARCHIVED');
      const res = await dev().put(
        `/variables/${old.id}`,
        putBodyOf(current.variable, { originUsedIn: 'OnStart' }),
        current.etag,
      );
      assert.equal(res.status, 422);
      assert.equal(bodyOf(res).code, 'APPLICATION_ARCHIVED');
      assert.equal(await columnOf(old.id), 'OnVisible');
    });
  });

  describe('the screen', () => {
    it('shows it only in the origin row; PUT /screens never changes it, and the origin row stays read-only', async () => {
      const { variable } = await create({ originScreenId: s2.id, originUsedIn: 'OnVisible' });
      const extra = await insertVariable(t, app.id, { name: 'gOther' });
      const { screen, etag } = await readScreen(s2.id);
      const origin = screen.variableLinks.find((l) => l.isOrigin && l.variable.id === variable.id)!;
      assert.equal(origin.originUsedIn, 'OnVisible');

      const body = screenPut(screen, {
        variableLinks: [
          { variableId: variable.id, accessMode: 'READ', usedIn: 'lblNombre.Text' },
          { variableId: extra.id, accessMode: 'READ', usedIn: 'OnVisible' },
        ],
      });
      const res = await dev().put(`/screens/${s2.id}`, body, etag);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      await assertConformsToContract(res);
      const links = screenOf(res).variableLinks.filter((l) => [variable.id, extra.id].includes(l.variable.id));
      assert.deepEqual(
        links.map((l) => [l.variable.name, l.usedIn, l.isOrigin, l.originUsedIn]).sort(),
        [
          [extra.name, 'OnVisible', false, null],
          [variable.name, 'lblNombre.Text', false, null],
          [variable.name, 'origin', true, 'OnVisible'],
        ].sort(),
      );
      assert.equal(await columnOf(variable.id), 'OnVisible');
    });

    it('the id of the origin row and usedIn "origin" are still rejected by PUT /screens', async () => {
      const { variable } = await create({ originScreenId: s2.id, originUsedIn: 'OnVisible' });
      const { screen, etag } = await readScreen(s2.id);
      const origin = screen.variableLinks.find((l) => l.isOrigin && l.variable.id === variable.id)!;
      const byId = await dev().put(
        `/screens/${s2.id}`,
        screenPut(screen, {
          variableLinks: [{ id: origin.id, variableId: variable.id, accessMode: 'WRITE', usedIn: 'OnVisible' }],
        }),
        etag,
      );
      assert.equal(byId.status, 404);
      assert.deepEqual(detailsOf(byId), { element: 'variable link', id: origin.id, field: 'variableLinks[0].id' });
      const byName = await dev().put(
        `/screens/${s2.id}`,
        screenPut(screen, { variableLinks: [{ variableId: variable.id, accessMode: 'WRITE', usedIn: 'origin' }] }),
        etag,
      );
      assert.equal(byName.status, 400);
    });

    it('a new screen answers originUsedIn null on every row; dependencies and listing keep their shape', async () => {
      const created = await createScreenVia(dev(), app.id);
      const detail = await readScreen(created.screen.id);
      assert.ok(detail.screen.variableLinks.every((l) => l.originUsedIn === null));

      const { variable } = await create({ originScreenId: s1.id, originUsedIn: 'OnVisible' });
      const dependencies = dependenciesOf(await admin().get(`/variables/${variable.id}/dependencies`));
      assert.deepEqual(dependencies.screens, [], 'the origin row is still reported as originScreen only');
      assert.equal(dependencies.originScreen?.id, s1.id);

      const page = variablesPageOf(await admin().get(`/variables?applicationId=${app.id}&originScreenId=${s1.id}`));
      assert.ok(page.data.some((v) => v.id === variable.id));
      assert.ok(
        page.data.every((v) => !('originUsedIn' in v)),
        'the summary does not carry it',
      );
    });
  });

  describe('the database', () => {
    it('clears it when the origin screen is deleted, and the variable keeps working', async () => {
      const doomed = await insertScreen(t, app.id, { name: 'Efimera' });
      const { variable } = await create({ originScreenId: doomed.id, originUsedIn: 'OnVisible' });
      await deleteScreen(t, doomed.id);
      assert.equal(await columnOf(variable.id), null);
      const after = await read(variable.id);
      assert.equal(after.variable.originScreen, null);
      assert.equal(after.variable.originUsedIn, null);
      assert.equal(after.variable.fullTraceability, false);

      const back = await dev().put(
        `/variables/${variable.id}`,
        putBodyOf(after.variable, { originScreenId: s1.id, originUsedIn: 'OnStart' }),
        after.etag,
      );
      assert.equal(back.status, 200, JSON.stringify(back.body));
      assert.equal(variableOf(back).originUsedIn, 'OnStart');
    });

    it('clears it whenever origin_screen_id becomes NULL, and refuses a blank or reserved value', async () => {
      const { variable } = await create({ originScreenId: s1.id, originUsedIn: 'OnVisible' });
      await t.owner.query('UPDATE variable SET origin_screen_id = NULL WHERE id = $1', [variable.id]);
      assert.equal(await columnOf(variable.id), null);

      await t.owner.query('UPDATE variable SET origin_screen_id = $2, origin_used_in = $3 WHERE id = $1', [
        variable.id,
        s1.id,
        'OnVisible',
      ]);
      for (const bad of ['', '   ', 'origin']) {
        await assert.rejects(
          t.owner.query('UPDATE variable SET origin_used_in = $2 WHERE id = $1', [variable.id, bad]),
          (error: { constraint?: string }) => error.constraint === 'variable_origin_used_in_chk',
          JSON.stringify(bad),
        );
      }
      assert.equal(await columnOf(variable.id), 'OnVisible');
    });

    it('the origin row of the variable is created and moved exactly as before', async () => {
      const { variable } = await create({ originScreenId: s1.id, originUsedIn: 'OnVisible' });
      const rows = async () =>
        (
          await t.owner.query<{ screen_id: number; access_mode: string; used_in: string }>(
            "SELECT screen_id, access_mode, used_in FROM screen_variable WHERE variable_id = $1 AND used_in = 'origin'",
            [variable.id],
          )
        ).rows;
      assert.deepEqual(await rows(), [{ screen_id: s1.id, access_mode: 'WRITE', used_in: 'origin' }]);
      await t.owner.query('UPDATE variable SET origin_screen_id = $2 WHERE id = $1', [variable.id, s2.id]);
      assert.deepEqual(await rows(), [{ screen_id: s2.id, access_mode: 'WRITE', used_in: 'origin' }]);
    });
  });
});
