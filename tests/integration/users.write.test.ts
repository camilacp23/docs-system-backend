/**
 * PUT /users/{id}, DELETE /users/{id}, PUT /users/{id}/role (FR-02, FR-03; D-09, D-38, D-62) against the real
 * service: ETag and If-Match, reserved account (A31-A33), self-deactivation (A21), role change and session
 * revocation (A19, A20), the immediate effect on tokens already issued, and the audit trail.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { EMAILS, login, prepareAuthUsers, refresh, rtPair, sessionOf } from '../helpers/auth.js';
import { adminsOf, asUser, createUser, userOf } from '../helpers/users.js';

describe('users: update, deactivate and role', () => {
  let t: TestApp;
  let admin: ReturnType<typeof asUser>;
  let reservedId: number;
  let seededId: number;

  before(async () => {
    t = await startTestApp();
    await prepareAuthUsers(t);
    admin = asUser(t, t.users.admin.token);
    reservedId = (await t.db.base.user.findUniqueOrThrow({ where: { email: EMAILS.reserved } })).id;
    seededId = (await adminsOf(t)).s.id;
  });
  after(async () => {
    await t.close();
  });

  const fresh = (over: Parameters<typeof createUser>[2] = {}) => createUser(t, t.users.admin.token, over);
  const putBody = (u: { name: string; email: string; status: string }, over: object = {}) => ({
    name: u.name,
    email: u.email,
    status: u.status,
    ...over,
  });
  const liveTokens = async (userId: number) =>
    Number(
      (
        await t.owner.query<{ n: string }>(
          'SELECT count(*) AS n FROM refresh_token WHERE user_id = $1 AND revoked_at IS NULL',
          [userId],
        )
      ).rows[0]!.n,
    );

  describe('PUT /users/{id}', () => {
    it('replaces name, e-mail (lowercased) and status, and the ETag changes', async () => {
      const { user } = await fresh();
      const before = (await admin.get(`/users/${user.id}`)).headers.etag;
      await sleep(5);
      const res = await admin.put(`/users/${user.id}`, {
        name: 'Renamed',
        email: 'New.Mail@Test.Local',
        status: 'INACTIVE',
      });
      assert.equal(res.status, 200);
      assert.deepEqual(
        { name: userOf(res).name, email: userOf(res).email, status: userOf(res).status, role: userOf(res).role },
        { name: 'Renamed', email: 'new.mail@test.local', status: 'INACTIVE', role: user.role },
      );
      assert.notEqual(res.headers.etag, before);
      assert.equal((await admin.get(`/users/${user.id}`)).headers.etag, res.headers.etag);
    });

    it('If-Match: the current ETag passes, no header passes, an old one is 412 with currentETag', async () => {
      const { user } = await fresh();
      const etag1 = String((await admin.get(`/users/${user.id}`)).headers.etag);
      await sleep(5);
      const ok = await admin.put(`/users/${user.id}`, putBody(user, { name: 'One' }), etag1);
      assert.equal(ok.status, 200);
      assert.notEqual(ok.headers.etag, etag1);
      const stale = await admin.put(`/users/${user.id}`, putBody(user, { name: 'Two' }), etag1);
      assert.equal(stale.status, 412);
      assert.equal(bodyOf(stale).code, 'PRECONDITION_FAILED');
      assert.equal((bodyOf(stale).details as unknown as { currentETag: string }).currentETag, ok.headers.etag);
      assert.equal(userOf(await admin.get(`/users/${user.id}`)).name, 'One');
      assert.equal((await admin.put(`/users/${user.id}`, putBody(user, { name: 'Three' }))).status, 200);
    });

    it('D-62 a login changes updatedAt, so an If-Match read before it is 412', async () => {
      const { user, email } = await fresh();
      const etag = String((await admin.get(`/users/${user.id}`)).headers.etag);
      await sleep(5);
      assert.equal((await login(t, email)).status, 200);
      assert.equal((await admin.put(`/users/${user.id}`, putBody(user), etag)).status, 412);
    });

    it('A31 the reserved account is 422 RESERVED_ACCOUNT, before If-Match and before any other rule', async () => {
      const res = await admin.put(
        `/users/${reservedId}`,
        { name: 'X', email: 'x@dept.local', status: 'ACTIVE' },
        'W/"1"',
      );
      assert.equal(res.status, 422);
      assert.equal(bodyOf(res).code, 'RESERVED_ACCOUNT');
      assert.equal(bodyOf(res).message, "This is a system account and can't be changed.");
      const row = await t.db.base.user.findUniqueOrThrow({ where: { id: reservedId } });
      assert.equal(row.status, 'INACTIVE');
      assert.equal(row.name, 'Integración Jira');
    });

    it('404 for an unknown user, even with a stale If-Match', async () => {
      const res = await admin.put('/users/987654', { name: 'X', email: 'x@dept.local', status: 'ACTIVE' }, 'W/"1"');
      assert.equal(res.status, 404);
      assert.equal(bodyOf(res).code, 'NOT_FOUND');
    });

    it('409 EMAIL_TAKEN when the e-mail belongs to another user (any case) or to the reserved account', async () => {
      const a = await fresh();
      const b = await fresh();
      for (const email of [a.email, a.email.toUpperCase(), EMAILS.reserved]) {
        const res = await admin.put(`/users/${b.user.id}`, putBody(b.user, { email }));
        assert.equal(res.status, 409, email);
        assert.equal(bodyOf(res).code, 'EMAIL_TAKEN');
      }
      assert.equal((await admin.put(`/users/${b.user.id}`, putBody(b.user))).status, 200); // its own e-mail is fine
    });

    it('400 for a missing field, an unknown field (role) or a weak password', async () => {
      const { user } = await fresh();
      for (const body of [
        { name: 'X', email: 'x@test.local' },
        putBody(user, { role: 'READER' }),
        putBody(user, { password: 'short1' }),
        putBody(user, { status: 'GONE' }),
      ]) {
        const res = await admin.put(`/users/${user.id}`, body);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.equal(bodyOf(res).code, 'VALIDATION_ERROR');
      }
    });

    it('A21 an administrator cannot deactivate themself (PUT)', async () => {
      const me = await t.db.base.user.findUniqueOrThrow({ where: { id: t.users.admin.id } });
      const res = await admin.put(`/users/${me.id}`, putBody(me, { status: 'INACTIVE' }));
      assert.equal(res.status, 422);
      assert.equal(bodyOf(res).code, 'CANNOT_DEACTIVATE_SELF');
      assert.equal((await t.db.base.user.findUniqueOrThrow({ where: { id: me.id } })).status, 'ACTIVE');
    });

    it('an administrator can edit themself without deactivating (name change keeps the session)', async () => {
      const me = await t.db.base.user.findUniqueOrThrow({ where: { id: t.users.admin.id } });
      const res = await admin.put(`/users/${me.id}`, putBody(me, { name: 'Ada Admin' }));
      assert.equal(res.status, 200);
    });

    it('a password change revokes every session, and only the new password signs in', async () => {
      const { user, email } = await fresh();
      const cookie = rtPair(await login(t, email));
      const other = rtPair(await login(t, email));
      assert.equal(await liveTokens(user.id), 2);
      const res = await admin.put(`/users/${user.id}`, putBody(user, { password: 'Otra-Clave-Nueva-9' }));
      assert.equal(res.status, 200);
      assert.equal(await liveTokens(user.id), 0);
      assert.equal((await refresh(t, cookie)).status, 401);
      assert.equal((await refresh(t, other)).status, 401);
      assert.equal((await login(t, email)).status, 401);
      assert.equal((await login(t, email, 'Otra-Clave-Nueva-9')).status, 200);
    });

    it('a PUT without password or deactivation keeps the sessions', async () => {
      const { user, email } = await fresh();
      await login(t, email);
      assert.equal((await admin.put(`/users/${user.id}`, putBody(user, { name: 'Same sessions' }))).status, 200);
      assert.equal(await liveTokens(user.id), 1);
    });

    it('A20 deactivating by PUT invalidates the access token and the refresh token; reactivating is allowed', async () => {
      const { user, email } = await fresh();
      const session = await login(t, email);
      const token = sessionOf(session).accessToken;
      assert.equal((await asUser(t, token).get(`/users/${user.id}`)).status, 200);
      const off = await admin.put(`/users/${user.id}`, putBody(user, { status: 'INACTIVE' }));
      assert.equal(off.status, 200);
      assert.equal((await asUser(t, token).get(`/users/${user.id}`)).status, 401);
      assert.equal((await refresh(t, rtPair(session))).status, 401);
      assert.equal((await login(t, email)).status, 401);
      const on = await admin.put(`/users/${user.id}`, putBody(userOf(off), { status: 'ACTIVE' }));
      assert.equal(on.status, 200);
      assert.equal(userOf(on).status, 'ACTIVE');
      assert.equal((await login(t, email)).status, 200);
    });
  });

  describe('DELETE /users/{id}', () => {
    it('204, status INACTIVE, the row stays, sessions revoked, tokens invalid (A20)', async () => {
      const { user, email } = await fresh();
      const session = await login(t, email);
      const token = sessionOf(session).accessToken;
      const res = await admin.delete(`/users/${user.id}`);
      assert.equal(res.status, 204);
      assert.equal(res.text, '');
      const row = await t.db.base.user.findUniqueOrThrow({ where: { id: user.id } });
      assert.equal(row.status, 'INACTIVE');
      assert.equal(row.email, email);
      assert.equal(await liveTokens(user.id), 0);
      assert.equal((await asUser(t, token).get('/users/' + user.id)).status, 401);
      assert.equal((await refresh(t, rtPair(session))).status, 401);
    });

    it('is idempotent: deactivating an inactive user is 204 again, with no new audit record', async () => {
      const { user } = await fresh();
      assert.equal((await admin.delete(`/users/${user.id}`)).status, 204);
      const count = () => t.db.base.auditLog.count({ where: { entityType: 'app_user', entityId: String(user.id) } });
      const before = await count();
      assert.equal((await admin.delete(`/users/${user.id}`)).status, 204);
      assert.equal(await count(), before);
      assert.equal(await t.db.base.user.count({ where: { id: user.id } }), 1);
    });

    it('A21 an administrator cannot deactivate themself (DELETE)', async () => {
      const res = await admin.delete(`/users/${t.users.admin.id}`);
      assert.equal(res.status, 422);
      assert.equal(bodyOf(res).code, 'CANNOT_DEACTIVATE_SELF');
      assert.equal(bodyOf(res).message, "You can't deactivate your own account.");
    });

    it('deactivating another administrator is allowed while one remains', async () => {
      const extra = await fresh({ role: 'ADMINISTRATOR' });
      assert.equal((await admin.delete(`/users/${extra.user.id}`)).status, 204);
    });

    it('A33 the reserved account is 422 RESERVED_ACCOUNT; an unknown user is 404', async () => {
      const res = await admin.delete(`/users/${reservedId}`);
      assert.equal(res.status, 422);
      assert.equal(bodyOf(res).code, 'RESERVED_ACCOUNT');
      assert.equal((await admin.delete('/users/987654')).status, 404);
    });
  });

  describe('PUT /users/{id}/role', () => {
    it('changes the role, returns the user with ETag and needs no If-Match', async () => {
      const { user } = await fresh();
      const res = await admin.put(`/users/${user.id}/role`, { role: 'READER' });
      assert.equal(res.status, 200);
      assert.equal(userOf(res).role, 'READER');
      assert.match(String(res.headers.etag), /^W\/"\d+"$/);
      const ignored = await admin.put(`/users/${user.id}/role`, { role: 'DEVELOPER' }, 'W/"1"');
      assert.equal(ignored.status, 200);
      assert.equal(userOf(ignored).role, 'DEVELOPER');
    });

    it('A19 a role change revokes the refresh tokens; A18 the old access token follows the new role', async () => {
      const { user, email } = await fresh({ role: 'DEVELOPER' });
      const session = await login(t, email);
      const token = sessionOf(session).accessToken;
      const post = () => asUser(t, token).post('/variables', {});
      assert.equal((await post()).status, 400); // passes the gate, fails validation
      assert.equal((await admin.put(`/users/${user.id}/role`, { role: 'READER' })).status, 200);
      assert.equal((await post()).status, 403);
      assert.equal((await refresh(t, rtPair(session))).status, 401);
      assert.equal(await liveTokens(user.id), 0);
    });

    it('the same role changes nothing: 200, sessions kept, no audit record', async () => {
      const { user, email } = await fresh({ role: 'READER' });
      await login(t, email);
      const count = () => t.db.base.auditLog.count({ where: { entityType: 'app_user', entityId: String(user.id) } });
      const before = await count();
      const res = await admin.put(`/users/${user.id}/role`, { role: 'READER' });
      assert.equal(res.status, 200);
      assert.equal(await liveTokens(user.id), 1);
      assert.equal(await count(), before);
    });

    it('A32 the reserved account is 422 RESERVED_ACCOUNT and keeps its role', async () => {
      const res = await admin.put(`/users/${reservedId}/role`, { role: 'ADMINISTRATOR' });
      assert.equal(res.status, 422);
      assert.equal(bodyOf(res).code, 'RESERVED_ACCOUNT');
      assert.equal((await t.db.base.user.findUniqueOrThrow({ where: { id: reservedId } })).role, 'READER');
    });

    it('400 for an invalid role or extra fields, 404 for an unknown user', async () => {
      assert.equal((await admin.put(`/users/${t.users.reader.id}/role`, { role: 'ROOT' })).status, 400);
      assert.equal((await admin.put(`/users/${t.users.reader.id}/role`, { role: 'READER', x: 1 })).status, 400);
      assert.equal((await admin.put('/users/987654/role', { role: 'READER' })).status, 404);
    });

    it('an administrator may demote another administrator while one remains, and an inactive one freely', async () => {
      const extra = await fresh({ role: 'ADMINISTRATOR' });
      assert.equal((await admin.put(`/users/${extra.user.id}/role`, { role: 'DEVELOPER' })).status, 200);
      const off = await fresh({ role: 'ADMINISTRATOR' });
      await admin.delete(`/users/${off.user.id}`);
      assert.equal((await admin.put(`/users/${off.user.id}/role`, { role: 'READER' })).status, 200);
    });

    it('LAST_ACTIVE_ADMIN: the only active administrator cannot demote themself', async () => {
      await t.owner.query(`UPDATE app_user SET role = 'DEVELOPER' WHERE id = $1`, [seededId]);
      try {
        const res = await admin.put(`/users/${t.users.admin.id}/role`, { role: 'READER' });
        assert.equal(res.status, 422);
        assert.equal(bodyOf(res).code, 'LAST_ACTIVE_ADMIN');
        assert.equal(
          bodyOf(res).message,
          'There must be at least one active administrator. Promote another user first.',
        );
        assert.equal(
          (await t.db.base.user.findUniqueOrThrow({ where: { id: t.users.admin.id } })).role,
          'ADMINISTRATOR',
        );
      } finally {
        await t.owner.query(`UPDATE app_user SET role = 'ADMINISTRATOR' WHERE id = $1`, [seededId]);
      }
    });
  });

  describe('audit (R-1, R-2)', () => {
    it('every write is recorded with the acting administrator; password_hash appears only as a field name', async () => {
      const { user } = await fresh();
      const secret = 'Clave-Auditada-12345';
      await admin.put(`/users/${user.id}`, putBody(user, { name: 'Audited', password: secret }));
      await admin.put(`/users/${user.id}/role`, { role: 'READER' });
      await admin.delete(`/users/${user.id}`);
      const rows = await t.db.base.auditLog.findMany({
        where: { entityType: 'app_user', entityId: String(user.id) },
        orderBy: { id: 'asc' },
      });
      assert.deepEqual(
        rows.map((r) => r.action),
        ['CREATE', 'UPDATE', 'UPDATE', 'UPDATE'],
      );
      assert.ok(rows.every((r) => r.actorUserId === t.users.admin.id && r.dbRole === 'docs_app'));
      assert.ok(rows[1]!.changedFields.includes('password_hash'));
      assert.deepEqual(rows[2]!.changedFields, ['role']);
      assert.deepEqual(rows[3]!.changedFields, ['status']);
      const stored = await t.owner.query<{ password_hash: string }>(
        'SELECT password_hash FROM app_user WHERE id = $1',
        [user.id],
      );
      for (const r of rows) {
        const text = JSON.stringify([r.oldValue, r.newValue]);
        assert.doesNotMatch(text, /password_hash|\$2[aby]\$/);
        assert.equal(text.includes(secret), false);
        assert.equal(text.includes(stored.rows[0]!.password_hash), false);
      }
    });

    it('no response of the write operations contains the password or its hash', async () => {
      const { user } = await fresh();
      const hashes = (await t.owner.query<{ password_hash: string }>('SELECT password_hash FROM app_user')).rows;
      const responses = [
        await admin.put(`/users/${user.id}`, putBody(user, { password: 'Otra-Clave-Nueva-9' })),
        await admin.put(`/users/${user.id}/role`, { role: 'READER' }),
        await admin.delete(`/users/${user.id}`),
        await admin.put(`/users/${reservedId}`, putBody(user)),
      ];
      for (const res of responses) {
        assert.doesNotMatch(res.text, /passwordHash|password_hash|Otra-Clave|\$2[aby]\$/);
        for (const h of hashes) assert.equal(res.text.includes(h.password_hash), false);
      }
    });
  });
});
