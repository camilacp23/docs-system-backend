/**
 * GET /users, POST /users, GET /users/{id} (FR-02, FR-04; SDD Table 46) against the real service: filters, sort,
 * pagination, the reserved account (A34, A35), creation rules, the role matrix of the six operations and the
 * guarantee that no response carries the password hash.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import bcrypt from 'bcryptjs';
import { bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { EMAILS, PASSWORD, prepareAuthUsers } from '../helpers/auth.js';
import { asUser, createUser, pageOf, userOf } from '../helpers/users.js';

const OPERATIONS = ['listUsers', 'createUser', 'getUser', 'updateUser', 'deactivateUser', 'changeUserRole'] as const;

describe('users: read and create', () => {
  let t: TestApp;
  let admin: ReturnType<typeof asUser>;
  const seenBodies: string[] = [];

  before(async () => {
    t = await startTestApp();
    await prepareAuthUsers(t);
    admin = asUser(t, t.users.admin.token);
  });
  after(async () => {
    await t.close();
  });

  const remember = <T extends { text: string }>(res: T): T => {
    seenBodies.push(res.text);
    return res;
  };

  describe('GET /users', () => {
    before(async () => {
      await createUser(t, t.users.admin.token, { name: 'Zoe Zapata', email: 'zoe@test.local', role: 'READER' });
      await createUser(t, t.users.admin.token, { name: 'Abel Araya', email: 'abel.araya@corp.local' });
      await createUser(t, t.users.admin.token, { name: '100% Real_User', email: 'pct@test.local' });
    });

    it('lists with the envelope, default page 1 / 20 and default sort by name', async () => {
      const res = remember(await admin.get('/users'));
      assert.equal(res.status, 200);
      const page = pageOf(res);
      assert.equal(page.page, 1);
      assert.equal(page.pageSize, 20);
      assert.equal(page.total, page.data.length);
      const names = page.data.map((u) => u.name);
      assert.deepEqual(names, [...names].sort((x, y) => x.localeCompare(y, 'en', { sensitivity: 'base' })).slice());
      assert.deepEqual(Object.keys(page.data[0]!).sort(), [
        'createdAt',
        'email',
        'id',
        'lastLoginAt',
        'name',
        'role',
        'status',
        'updatedAt',
      ]);
    });

    it('A34 never lists the reserved account and total does not count it', async () => {
      const page = pageOf(remember(await admin.get('/users?pageSize=100')));
      const all = await t.db.base.user.count();
      assert.equal(
        page.data.some((u) => u.email === EMAILS.reserved),
        false,
      );
      assert.equal(page.total, all - 1);
      assert.equal(pageOf(await admin.get(`/users?q=integracion`)).total, 0);
    });

    it('q matches name or e-mail, case-insensitive, and treats % and _ literally', async () => {
      assert.deepEqual(
        pageOf(await admin.get('/users?q=ZAPATA')).data.map((u) => u.email),
        ['zoe@test.local'],
      );
      assert.deepEqual(
        pageOf(await admin.get('/users?q=corp.LOCAL')).data.map((u) => u.name),
        ['Abel Araya'],
      );
      assert.deepEqual(
        pageOf(await admin.get(`/users?q=${encodeURIComponent('100%')}`)).data.map((u) => u.email),
        ['pct@test.local'],
      );
      assert.equal(pageOf(await admin.get(`/users?q=${encodeURIComponent('%')}`)).total, 1);
      assert.equal(pageOf(await admin.get(`/users?q=${encodeURIComponent('_')}`)).total, 1);
    });

    it('filters by role and by status and combines them', async () => {
      const readers = pageOf(await admin.get('/users?role=READER'));
      assert.ok(readers.data.length >= 2 && readers.data.every((u) => u.role === 'READER'));
      const inactive = pageOf(await admin.get('/users?status=INACTIVE'));
      assert.deepEqual(
        inactive.data.map((u) => u.email),
        [EMAILS.inactive],
      );
      const both = pageOf(await admin.get('/users?role=DEVELOPER&status=INACTIVE'));
      assert.deepEqual(
        both.data.map((u) => u.email),
        [EMAILS.inactive],
      );
      assert.equal(pageOf(await admin.get('/users?role=ADMINISTRATOR&status=INACTIVE')).total, 0);
      assert.equal((await admin.get('/users?role=ROOT')).status, 400);
      assert.equal((await admin.get('/users?status=GONE')).status, 400);
    });

    it('sorts by every allowed field in both directions; nulls of lastLoginAt go last', async () => {
      await t.owner.query(`UPDATE app_user SET last_login_at = now() WHERE email = $1`, ['zoe@test.local']);
      for (const field of ['name', 'email', 'createdAt', 'lastLoginAt'] as const) {
        for (const prefix of ['', '-']) {
          const res = await admin.get(`/users?pageSize=100&sort=${prefix}${field}`);
          assert.equal(res.status, 200, `${prefix}${field}`);
          const rows = pageOf(res).data;
          const key = (u: (typeof rows)[number]) => u[field];
          if (field === 'lastLoginAt') {
            const firstNull = rows.findIndex((u) => u.lastLoginAt === null);
            assert.ok(firstNull > 0, 'nulls are last');
            assert.ok(rows.slice(firstNull).every((u) => u.lastLoginAt === null));
          } else if (field === 'name' || field === 'email') {
            const values = rows.map((u) => String(key(u)).toLowerCase());
            assert.equal(new Set(values).size, values.length);
          }
        }
      }
      const asc = pageOf(await admin.get('/users?pageSize=100&sort=email')).data.map((u) => u.email);
      const desc = pageOf(await admin.get('/users?pageSize=100&sort=-email')).data.map((u) => u.email);
      assert.deepEqual([...asc].reverse(), desc);
      const bad = await admin.get('/users?sort=passwordHash');
      assert.equal(bad.status, 400);
      assert.equal(bodyOf(bad).code, 'VALIDATION_ERROR');
    });

    it('paginates: pages do not overlap, the last page is partial and pageSize is capped at 100', async () => {
      const all = pageOf(await admin.get('/users?pageSize=100'));
      const p1 = pageOf(await admin.get('/users?pageSize=3&page=1'));
      const p2 = pageOf(await admin.get('/users?pageSize=3&page=2'));
      assert.equal(p1.total, all.total);
      assert.deepEqual(
        [...p1.data, ...p2.data].map((u) => u.id),
        all.data.slice(0, 6).map((u) => u.id),
      );
      assert.equal(pageOf(await admin.get('/users?pageSize=3&page=999')).data.length, 0);
      assert.equal((await admin.get('/users?pageSize=101')).status, 400);
      assert.equal((await admin.get('/users?page=0')).status, 400);
    });
  });

  describe('POST /users', () => {
    it('201 + Location + ETag, lowercase e-mail, bcrypt hash that verifies, no hash in the body', async () => {
      const res = remember(
        await admin.post('/users', {
          name: 'Ana Mora',
          email: 'Ana.Mora@Dept.Local',
          password: PASSWORD,
          role: 'DEVELOPER',
        }),
      );
      assert.equal(res.status, 201);
      const user = userOf(res);
      assert.equal(user.email, 'ana.mora@dept.local');
      assert.equal(user.role, 'DEVELOPER');
      assert.equal(user.status, 'ACTIVE');
      assert.equal(user.lastLoginAt, null);
      assert.equal(res.headers.location, `/api/v1/users/${user.id}`);
      assert.equal(res.headers.etag, `W/"${new Date(user.updatedAt).getTime()}"`);
      const row = await t.owner.query<{ password_hash: string }>('SELECT password_hash FROM app_user WHERE id = $1', [
        user.id,
      ]);
      const hash = row.rows[0]!.password_hash;
      assert.match(hash, /^\$2[aby]\$/);
      assert.notEqual(hash, PASSWORD);
      assert.equal(await bcrypt.compare(PASSWORD, hash), true);
    });

    it('409 EMAIL_TAKEN for a duplicate in any case and for the reserved e-mail', async () => {
      await createUser(t, t.users.admin.token, { email: 'dup@test.local' });
      for (const email of ['dup@test.local', 'DUP@test.LOCAL', EMAILS.reserved]) {
        const res = await admin.post('/users', { name: 'X', email, password: PASSWORD, role: 'READER' });
        assert.equal(res.status, 409, email);
        assert.equal(bodyOf(res).code, 'EMAIL_TAKEN');
        assert.equal(bodyOf(res).message, 'A user with this email already exists.');
      }
    });

    it('400 for a weak password, a missing field, an unknown field or an invalid role', async () => {
      const ok = { name: 'N', email: 'bad@test.local', password: PASSWORD, role: 'READER' };
      for (const body of [
        { ...ok, password: 'short1' },
        { ...ok, password: 'onlyletterslongenough' },
        { ...ok, password: '123456789012' },
        { ...ok, name: undefined },
        { ...ok, status: 'ACTIVE' },
        { ...ok, role: 'ROOT' },
        { ...ok, email: 'not-an-email' },
      ]) {
        const res = await admin.post('/users', body);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.equal(bodyOf(res).code, 'VALIDATION_ERROR');
      }
      assert.equal(await t.db.base.user.count({ where: { email: 'bad@test.local' } }), 0);
    });

    it('400 VALIDATION_ERROR (not 500) for a blank name that only the database CHECK rejects', async () => {
      const res = await admin.post('/users', {
        name: '   ',
        email: 'blank@test.local',
        password: PASSWORD,
        role: 'READER',
      });
      assert.equal(res.status, 400);
      assert.equal(bodyOf(res).code, 'VALIDATION_ERROR');
    });
  });

  describe('GET /users/{id}', () => {
    it('an administrator reads any user, with ETag', async () => {
      const res = remember(await admin.get(`/users/${t.users.reader.id}`));
      assert.equal(res.status, 200);
      assert.equal(userOf(res).email, EMAILS.reader);
      assert.match(String(res.headers.etag), /^W\/"\d+"$/);
    });

    it('A24 a user reads their own record; another user is 403', async () => {
      for (const key of ['developer', 'reader'] as const) {
        const me = asUser(t, t.users[key].token);
        assert.equal(remember(await me.get(`/users/${t.users[key].id}`)).status, 200);
        assert.equal((await me.get(`/users/${t.users.admin.id}`)).status, 403);
      }
    });

    it('A35 the reserved account is 404 for everyone, and so is an unknown or out-of-range id', async () => {
      const reserved = await t.db.base.user.findUniqueOrThrow({ where: { email: EMAILS.reserved } });
      const res = await admin.get(`/users/${reserved.id}`);
      assert.equal(res.status, 404);
      assert.equal(bodyOf(res).code, 'NOT_FOUND');
      assert.equal(bodyOf(res).message, "This user doesn't exist. It may have been deleted.");
      assert.equal((await asUser(t, t.users.developer.token).get(`/users/${reserved.id}`)).status, 403);
      assert.equal((await admin.get('/users/987654')).status, 404);
      assert.equal((await admin.get('/users/2147483648')).status, 404);
      assert.equal((await admin.get('/users/abc')).status, 400);
    });
  });

  describe('operations, roles and secrets', () => {
    it('the six operations are implemented (no NOT_IMPLEMENTED)', async () => {
      for (const op of OPERATIONS) assert.equal(t.built.notImplemented.includes(op), false, op);
      const reserved = await t.db.base.user.findUniqueOrThrow({ where: { email: EMAILS.reserved } });
      const calls = [
        admin.get('/users'),
        admin.post('/users', { name: 'R', email: 'routes@test.local', password: PASSWORD, role: 'READER' }),
        admin.get(`/users/${t.users.reader.id}`),
        admin.put(`/users/${reserved.id}`, { name: 'X', email: 'x@test.local', status: 'ACTIVE' }),
        admin.delete(`/users/${reserved.id}`),
        admin.put(`/users/${reserved.id}/role`, { role: 'READER' }),
      ];
      for (const res of await Promise.all(calls)) {
        assert.notEqual(bodyOf(res).details?.reason, 'NOT_IMPLEMENTED');
      }
    });

    it('role matrix: Developer and Reader get 403 on all six, except GET of their own record (200)', async () => {
      const target = t.users.inactive.id;
      for (const key of ['developer', 'reader'] as const) {
        const me = asUser(t, t.users[key].token);
        const results = await Promise.all([
          me.get('/users'),
          me.post('/users', { name: 'N', email: 'matrix@test.local', password: PASSWORD, role: 'READER' }),
          me.get(`/users/${target}`),
          me.put(`/users/${target}`, { name: 'N', email: 'inactive@test.local', status: 'INACTIVE' }),
          me.delete(`/users/${target}`),
          me.put(`/users/${target}/role`, { role: 'READER' }),
        ]);
        for (const [i, res] of results.entries()) {
          assert.equal(res.status, 403, `${key} ${OPERATIONS[i]}`);
          assert.equal(bodyOf(res).code, 'FORBIDDEN');
        }
        assert.equal((await me.get(`/users/${t.users[key].id}`)).status, 200);
      }
      assert.equal(await t.db.base.user.count({ where: { email: 'matrix@test.local' } }), 0);
    });

    it('no response contains passwordHash, password_hash or a bcrypt hash', async () => {
      const hashes = await t.owner.query<{ password_hash: string }>('SELECT password_hash FROM app_user');
      assert.ok(seenBodies.length >= 5);
      for (const body of seenBodies) {
        assert.doesNotMatch(body, /passwordHash|password_hash|"password"/i);
        assert.doesNotMatch(body, /\$2[aby]\$/);
        for (const h of hashes.rows) assert.equal(body.includes(h.password_hash), false);
      }
    });
  });
});
