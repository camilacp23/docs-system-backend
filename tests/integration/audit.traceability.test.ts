/**
 * Traceability end to end (FR-20, FR-21, NFR-20): a real edit through the API in Modules 1 to 4 (user, application,
 * variable, collection with a field, screen with a link) appears in `GET /audit-log` with its actor, date, changed
 * fields and the old and new values in camelCase; every kind of action exists (CREATE, UPDATE, DELETE and the EVENTs of
 * the review); the record of a deleted element stays readable; a write outside the API has no actor; and the password
 * hash never appears. Every 200 is checked against the contract. Nothing is written to `audit_log` by hand: the
 * trigger writes it, and the owner's writes are plain SQL on the audited tables.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { applicationOf, createApplication, putBodyOf as applicationPut } from '../helpers/applications.js';
import { prepareAuthUsers } from '../helpers/auth.js';
import { collectionOf, createBodyOf as collectionBody, putBodyOf as collectionPut } from '../helpers/collections.js';
import { assertConformsToContract } from '../helpers/contractResponse.js';
import {
  createScreenInStatus,
  createScreenVia,
  fullTemplate,
  putBodyOf as screenPut,
  screenOf,
} from '../helpers/screens.js';
import { createUser, asUser } from '../helpers/users.js';
import { createBodyOf as variableBody, putBodyOf as variablePut, variableOf } from '../helpers/variables.js';

type Entry = {
  id: string;
  action: string;
  eventName: string | null;
  entityType: string;
  entityId: string;
  entityLabel: string | null;
  applicationId: number | null;
  actor: { id: number; name: string } | null;
  dbRole?: string;
  changedFields: string[];
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  createdAt: string;
};

describe('audit: traceability of the writes of Modules 1 to 4', () => {
  let t: TestApp;
  let reservedId: number;

  /** The entries of one element, newest first, as the Administrator reads them. */
  const history = async (entityType: string, entityId: string | number): Promise<Entry[]> => {
    const res = await t.http
      .get('/api/v1/audit-log')
      .query({ entityType, entityId: String(entityId), pageSize: 100 })
      .set('Authorization', `Bearer ${t.users.admin.token}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    await assertConformsToContract(res);
    return (res.body as { data: Entry[] }).data;
  };
  const only = (entries: Entry[], action: string): Entry => {
    const found = entries.filter((e) => e.action === action);
    assert.equal(found.length, 1, `${action}: ${JSON.stringify(entries.map((e) => e.action))}`);
    return found[0]!;
  };
  /** Runs `sql` as the database user `userId` would through the API (the setting the audit trigger reads). */
  const writeAs = async (userId: number, sql: string, params: unknown[] = []) => {
    await t.owner.query('BEGIN');
    try {
      await t.owner.query(`SELECT set_config('app.user_id', $1, true)`, [String(userId)]);
      await t.owner.query(sql, params);
      await t.owner.query('COMMIT');
    } catch (error) {
      await t.owner.query('ROLLBACK');
      throw error;
    }
  };

  before(async () => {
    t = await startTestApp();
    try {
      await prepareAuthUsers(t);
      const reserved = await t.owner.query<{ id: number }>('SELECT id FROM app_user WHERE email = $1', [
        t.config.integrationUserEmail,
      ]);
      reservedId = reserved.rows[0]!.id;
    } catch (error) {
      await t.close();
      throw error;
    }
  });
  after(async () => {
    await t.close();
  });

  const admin = () => asUser(t, t.users.admin.token);
  const dev = () => asUser(t, t.users.developer.token);

  it('Module 1, a user: the update shows who, when, the changed fields and the old and new values', async () => {
    const { user } = await createUser(t, t.users.admin.token, { name: 'Before Name', role: 'DEVELOPER' });
    const res = await admin().put(`/users/${user.id}`, { name: 'After Name', email: user.email, status: 'ACTIVE' });
    assert.equal(res.status, 200);
    const entries = await history('app_user', user.id);
    const update = only(entries, 'UPDATE');
    assert.deepEqual(update.actor, { id: t.users.admin.id, name: 'Ada Admin' });
    assert.ok(Date.now() - Date.parse(update.createdAt) < 60_000);
    assert.deepEqual(update.changedFields, ['name']);
    assert.equal(update.oldValue?.['name'], 'Before Name');
    assert.equal(update.newValue?.['name'], 'After Name');
    assert.equal(update.entityLabel, 'After Name');
    assert.equal(update.dbRole, 'docs_app');
    assert.ok('lastLoginAt' in (update.newValue ?? {}) && 'createdAt' in (update.newValue ?? {}), 'camelCase keys');
    assert.ok(!Object.keys(update.newValue ?? {}).some((k) => k.includes('_')), 'no snake_case key');
    const create = only(entries, 'CREATE');
    assert.equal(create.oldValue, null);
    assert.equal(create.newValue?.['name'], 'Before Name');
  });

  it('a password change shows passwordHash in changedFields and no value anywhere', async () => {
    const { user } = await createUser(t, t.users.admin.token, { role: 'DEVELOPER' });
    const before = (
      await t.owner.query<{ h: string }>('SELECT password_hash AS h FROM app_user WHERE id = $1', [user.id])
    ).rows[0]!.h;
    const res = await admin().put(`/users/${user.id}`, {
      name: user.name,
      email: user.email,
      status: 'ACTIVE',
      password: 'Otra-Clave-Segura-2027',
    });
    assert.equal(res.status, 200);
    const after = (
      await t.owner.query<{ h: string }>('SELECT password_hash AS h FROM app_user WHERE id = $1', [user.id])
    ).rows[0]!.h;
    assert.notEqual(before, after);
    const list = await t.http
      .get('/api/v1/audit-log')
      .query({ entityType: 'app_user', entityId: String(user.id) })
      .set('Authorization', `Bearer ${t.users.admin.token}`);
    await assertConformsToContract(list);
    const update = only((list.body as { data: Entry[] }).data, 'UPDATE');
    assert.ok(update.changedFields.includes('passwordHash'));
    for (const value of [update.oldValue, update.newValue]) {
      assert.ok(value && !('passwordHash' in value) && !('password_hash' in value));
    }
    const text = JSON.stringify(list.body);
    assert.ok(!text.includes(before) && !text.includes(after) && !text.includes('$2'), 'no hash in the response');
    // The same holds for the whole audit log of the database, not only this element.
    const all = await t.owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log WHERE old_value::text LIKE '%password%' OR new_value::text LIKE '%password%'`,
    );
    assert.equal(all.rows[0]!.n, '0', 'the trigger stored no value of password_hash');
  });

  it('Module 1, an application: the update records only what changed', async () => {
    const { application } = await createApplication(t, t.users.admin.token, { description: 'old text' });
    const res = await admin().put(
      `/applications/${application.id}`,
      applicationPut(application, { description: 'new text' }),
    );
    assert.equal(res.status, 200);
    const update = only(await history('application', application.id), 'UPDATE');
    assert.deepEqual(update.changedFields, ['description']);
    assert.equal(update.oldValue?.['description'], 'old text');
    assert.equal(update.newValue?.['description'], 'new text');
    assert.equal(update.applicationId, application.id);
    assert.deepEqual(update.actor, { id: t.users.admin.id, name: 'Ada Admin' });
    assert.equal(applicationOf(res).description, 'new text');
  });

  it('Module 2, a variable: create, update and delete; the record of the deleted element stays readable (NFR-20)', async () => {
    const { application } = await createApplication(t, t.users.admin.token);
    const created = variableOf(await dev().post('/variables', variableBody(application.id, { name: 'gTrace' })));
    const put = await admin().put(
      `/variables/${created.id}`,
      variablePut(created, { description: 'now described', dataType: 'NUMBER' }),
    );
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal((await admin().delete(`/variables/${created.id}`)).status, 204);

    const entries = await history('variable', created.id);
    assert.deepEqual(
      entries.map((e) => e.action),
      ['DELETE', 'UPDATE', 'CREATE'],
    );
    const create = only(entries, 'CREATE');
    assert.equal(create.actor?.id, t.users.developer.id);
    assert.equal(create.oldValue, null);
    assert.equal(create.newValue?.['name'], 'gTrace');
    assert.equal(create.newValue?.['dataType'], 'TEXT');
    const update = only(entries, 'UPDATE');
    assert.deepEqual([...update.changedFields].sort(), ['dataType', 'description']);
    assert.equal(update.oldValue?.['dataType'], 'TEXT');
    assert.equal(update.newValue?.['dataType'], 'NUMBER');
    assert.equal(update.actor?.id, t.users.admin.id);
    const del = only(entries, 'DELETE');
    assert.equal(del.newValue, null);
    assert.equal(del.oldValue?.['name'], 'gTrace');
    assert.equal(del.entityLabel, 'gTrace');
    assert.equal(del.changedFields.length, 0);
    assert.equal(del.applicationId, application.id);
    // The element is gone, its history is not.
    assert.equal((await admin().get(`/variables/${created.id}`)).status, 404);
    const byApplication = await t.http
      .get('/api/v1/audit-log')
      .query({ applicationId: application.id, entityType: 'variable' })
      .set('Authorization', `Bearer ${t.users.admin.token}`);
    assert.equal((byApplication.body as { total: number }).total, 3);
  });

  it('Module 3, a collection with a field: the field is audited as its own entity, with keys in camelCase', async () => {
    const { application } = await createApplication(t, t.users.admin.token);
    const created = collectionOf(
      await dev().post(
        '/collections',
        collectionBody(application.id, {
          name: 'colTrace',
          fields: [{ name: 'colTitle', dataType: 'TEXT', description: 'first', position: 1 }],
        }),
      ),
    );
    const field = created.fields[0]!;
    const put = await admin().put(
      `/collections/${created.id}`,
      collectionPut(created, {
        fields: [{ id: field.id, name: 'colTitle', dataType: 'TEXT', description: 'second', position: 1 }],
      }),
    );
    assert.equal(put.status, 200, JSON.stringify(put.body));

    const fieldEntries = await history('collection_field', field.id);
    const create = only(fieldEntries, 'CREATE');
    assert.equal(create.newValue?.['collectionId'], created.id);
    assert.equal(create.newValue?.['dataType'], 'TEXT');
    assert.equal(create.actor?.id, t.users.developer.id);
    const update = only(fieldEntries, 'UPDATE');
    assert.deepEqual(update.changedFields, ['description']);
    assert.equal(update.oldValue?.['description'], 'first');
    assert.equal(update.newValue?.['description'], 'second');
    assert.equal(update.actor?.id, t.users.admin.id);
    assert.equal(update.applicationId, application.id);
    assert.equal(only(await history('collection', created.id), 'CREATE').newValue?.['name'], 'colTrace');
  });

  it('Module 4, a screen with a link: the screen update and the link are audited', async () => {
    const { application } = await createApplication(t, t.users.admin.token);
    const variable = variableOf(await admin().post('/variables', variableBody(application.id, { name: 'gLinked' })));
    const { screen } = await createScreenVia(dev(), application.id, {
      variableLinks: [{ variableId: variable.id, accessMode: 'READ', usedIn: 'OnVisible' }],
    });
    const put = await dev().put(
      `/screens/${screen.id}`,
      screenPut(screen, { template: { ...screen.template, knownIssues: 'Slow on the first load.' } }),
    );
    assert.equal(put.status, 200, JSON.stringify(put.body));
    const read = screenOf(put);

    const update = only(await history('screen', screen.id), 'UPDATE');
    assert.deepEqual(update.changedFields, ['documentationStatus', 'knownIssues']);
    assert.equal(update.oldValue?.['documentationStatus'], 'UNDOCUMENTED');
    assert.equal(update.newValue?.['documentationStatus'], 'DRAFT');
    assert.equal(update.oldValue?.['knownIssues'], null);
    assert.equal(update.newValue?.['knownIssues'], 'Slow on the first load.');
    assert.equal(update.actor?.id, t.users.developer.id);
    assert.equal(update.entityLabel, screen.name);
    assert.equal(read.template.knownIssues, 'Slow on the first load.');

    const link = read.variableLinks.find((l) => !l.isOrigin)!;
    const created = only(await history('screen_variable', link.id), 'CREATE');
    assert.equal(created.entityLabel, 'OnVisible');
    assert.equal(created.newValue?.['screenId'], screen.id);
    assert.equal(created.newValue?.['variableId'], variable.id);
    assert.equal(created.newValue?.['accessMode'], 'READ');
    assert.equal(created.actor?.id, t.users.developer.id);
  });

  it('the review records EVENTs: DOCUMENTATION_RETURNED and DOCUMENTATION_APPROVED with their payload in newValue', async () => {
    const { application } = await createApplication(t, t.users.admin.token);
    const { screen } = await createScreenInStatus(t, dev(), application.id, 'IN_REVIEW', fullTemplate());
    const returned = await admin().post(`/screens/${screen.id}/review`, {
      decision: 'RETURN',
      comment: 'Please add detail.',
    });
    assert.equal(returned.status, 200, JSON.stringify(returned.body));
    await t.owner.query(`UPDATE screen SET documentation_status = 'IN_REVIEW' WHERE id = $1`, [screen.id]);
    const approved = await admin().post(`/screens/${screen.id}/review`, { decision: 'APPROVE' });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));

    const events = (await history('screen', screen.id)).filter((e) => e.action === 'EVENT');
    assert.deepEqual(
      events.map((e) => e.eventName),
      ['DOCUMENTATION_APPROVED', 'DOCUMENTATION_RETURNED'],
    );
    const [approvedEvent, returnedEvent] = events as [Entry, Entry];
    assert.deepEqual(returnedEvent.newValue?.['from'], 'IN_REVIEW');
    assert.deepEqual(returnedEvent.newValue?.['to'], 'IN_PROGRESS');
    assert.equal(typeof returnedEvent.newValue?.['commentId'], 'number');
    assert.deepEqual(approvedEvent.newValue, { from: 'IN_REVIEW', to: 'APPROVED', commentId: null });
    for (const e of events) {
      assert.equal(e.oldValue, null);
      assert.deepEqual(e.changedFields, []);
      assert.equal(e.entityType, 'screen');
      assert.equal(e.entityId, String(screen.id));
      assert.equal(e.entityLabel, screen.name);
      assert.equal(e.actor?.id, t.users.admin.id);
      assert.equal(e.applicationId, application.id);
    }
    // The review comment (CP-11) is audited too, with the decision in camelCase.
    const comment = await t.http
      .get('/api/v1/audit-log')
      .query({ applicationId: application.id, entityType: 'comment', action: 'CREATE' })
      .set('Authorization', `Bearer ${t.users.admin.token}`);
    await assertConformsToContract(comment);
    const created = (comment.body as { data: Entry[] }).data;
    assert.equal(created.length, 1);
    assert.equal(created[0]!.newValue?.['reviewDecision'], 'RETURN');
  });

  it('all four kinds of action exist in the log', async () => {
    const res = await t.http
      .get('/api/v1/audit-log')
      .query({ pageSize: 100 })
      .set('Authorization', `Bearer ${t.users.admin.token}`);
    const actions = new Set((res.body as { data: Entry[] }).data.map((e) => e.action));
    for (const action of ['CREATE', 'UPDATE', 'DELETE', 'EVENT']) assert.ok(actions.has(action), action);
  });

  it('a write outside the API (SQL as the owner) has no actor and shows the database role', async () => {
    const { application } = await createApplication(t, t.users.admin.token);
    await t.owner.query(`UPDATE application SET description = 'edited by a DBA' WHERE id = $1`, [application.id]);
    const update = only(await history('application', application.id), 'UPDATE');
    assert.equal(update.actor, null);
    assert.equal(update.dbRole, 'docs_owner');
    assert.equal(update.newValue?.['description'], 'edited by a DBA');
  });

  it('the actor is resolved when the user is inactive, and for the reserved account "Integración Jira"', async () => {
    const { application } = await createApplication(t, t.users.admin.token);
    await writeAs(t.users.inactive.id, `UPDATE application SET description = 'by an inactive user' WHERE id = $1`, [
      application.id,
    ]);
    await writeAs(reservedId, `UPDATE application SET description = 'by the integration' WHERE id = $1`, [
      application.id,
    ]);
    const updates = (await history('application', application.id)).filter((e) => e.action === 'UPDATE');
    assert.deepEqual(
      updates.map((e) => e.actor),
      [
        { id: reservedId, name: 'Integración Jira' },
        { id: t.users.inactive.id, name: 'Ina Ctive' },
      ],
    );
  });

  it('a Developer reads their own actions with values, and none of the Administrator', async () => {
    const res = await dev().get('/audit-log?pageSize=100');
    assert.equal(res.status, 200);
    await assertConformsToContract(res);
    const entries = (res.body as { data: Entry[] }).data;
    assert.ok(entries.length > 0);
    assert.ok(entries.every((e) => e.actor?.id === t.users.developer.id && !('dbRole' in e)));
    assert.ok(entries.some((e) => e.newValue !== null));
  });
});
