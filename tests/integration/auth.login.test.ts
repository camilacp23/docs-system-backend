/**
 * POST /auth/login on the real application (FR-01, NFR-01, NFR-02, D-25, D-27, D-36, D-61). Equivalents of A01-A12,
 * A18, A20 and A30 of test 07, on a disposable database.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import jwt from 'jsonwebtoken';
import { bearer, bodyOf, startTestApp, type TestApp } from '../helpers/app.js';
import { EMAILS, login, prepareAuthUsers, refresh, rtLine, rtPair, sessionOf } from '../helpers/auth.js';

describe('POST /auth/login', () => {
  let t: TestApp;
  before(async () => {
    t = await startTestApp();
    await prepareAuthUsers(t);
  });
  after(async () => {
    await t.close();
  });

  const claimsOf = (token: string) => jwt.decode(token, { complete: true })!;
  const probe = (token: string) => t.http.get('/api/v1/users').set('Authorization', bearer(token));

  it('A01 returns the access token, the user and sessionExpiresIn (D-61); the routes are no longer NOT_IMPLEMENTED', async () => {
    const res = await login(t, 'Admin@Test.LOCAL');
    assert.equal(res.status, 200);
    const data = sessionOf(res);
    assert.equal(data.tokenType, 'Bearer');
    assert.equal(data.expiresIn, 28800);
    assert.ok(Number.isInteger(data.sessionExpiresIn));
    assert.ok(data.sessionExpiresIn <= 43200 && data.sessionExpiresIn > 43200 - 60);
    assert.equal(data.user.id, t.users.admin.id);
    assert.equal(data.user.email, EMAILS.admin);
    assert.equal(data.user.role, 'ADMINISTRATOR');
    assert.deepEqual(Object.keys(data.user).sort(), [
      'createdAt',
      'email',
      'id',
      'lastLoginAt',
      'name',
      'role',
      'status',
      'updatedAt',
    ]);
    assert.notEqual(data.user.lastLoginAt, null);
    assert.equal(res.headers['cache-control'], 'no-store');
    for (const op of ['login', 'refreshSession', 'logout']) {
      assert.equal(t.built.notImplemented.includes(op), false, op);
    }
  });

  it('A02 sets the rt cookie: HttpOnly, Secure, SameSite=Strict, Path=/api/v1/auth, Expires = session end (12 h)', async () => {
    const res = await login(t, EMAILS.developer);
    const line = rtLine(res);
    assert.match(line, /; HttpOnly/);
    assert.match(line, /; Secure/);
    assert.match(line, /; SameSite=Strict/);
    assert.match(line, /; Path=\/api\/v1\/auth/);
    assert.doesNotMatch(line, /Max-Age/i);
    const expires = new Date(/Expires=([^;]+)/.exec(line)![1]!).getTime();
    const hours = (expires - Date.now()) / 3_600_000;
    assert.ok(Math.abs(hours - 12) < 0.01, `expires in ${hours.toFixed(3)} h`);
  });

  it('A03 the access token is HS256 with kid, iss, aud, sub, jti, 8 h and no role', async () => {
    const res = await login(t, EMAILS.reader);
    const jwtParts = claimsOf(sessionOf(res).accessToken);
    const payload = jwtParts.payload as jwt.JwtPayload;
    assert.equal(jwtParts.header.alg, 'HS256');
    assert.equal(jwtParts.header.kid, t.config.jwtKeys[0]!.kid);
    assert.equal(payload.iss, 'docs-system-api');
    assert.equal(payload.aud, 'docs-system-web');
    assert.equal(payload.sub, String(t.users.reader.id));
    assert.ok(typeof payload.jti === 'string' && payload.jti.length > 0);
    assert.equal(payload.exp! - payload.iat!, 28800);
    assert.equal('role' in payload, false);
  });

  it('A04 wrong password, unknown e-mail and inactive account: the same 401 INVALID_CREDENTIALS (D-27)', async () => {
    const wrong = await login(t, EMAILS.admin, 'incorrecta-123');
    const unknown = await login(t, 'nadie@test.local');
    const inactive = await login(t, EMAILS.inactive);
    for (const res of [wrong, unknown, inactive]) {
      assert.equal(res.status, 401);
      assert.equal(bodyOf(res).code, 'INVALID_CREDENTIALS');
      assert.equal(rtLine(res), '');
    }
    assert.deepEqual(wrong.body, unknown.body);
    assert.deepEqual(wrong.body, inactive.body);
    assert.equal(bodyOf(wrong).message, 'The email or password is incorrect.');
  });

  it('A05/A30 the reserved account always gets that 401, even with its e-mail in capitals', async () => {
    const reserved = await login(t, EMAILS.reserved);
    const capitals = await login(t, 'Integracion.Jira@System.Local');
    const nobody = await login(t, 'nadie2@test.local');
    assert.equal(reserved.status, 401);
    assert.equal(capitals.status, 401);
    assert.deepEqual(reserved.body, nobody.body);
    assert.deepEqual(capitals.body, nobody.body);
  });

  it('A06 last_login_at is audited with the user as actor', async () => {
    const before = await t.db.base.user.findUniqueOrThrow({ where: { id: t.users.admin.id } });
    await login(t, EMAILS.admin);
    const row = await t.db.base.auditLog.findFirst({
      where: { entityType: 'app_user', entityId: String(t.users.admin.id), changedFields: { has: 'last_login_at' } },
      orderBy: { id: 'desc' },
    });
    assert.equal(row?.actorUserId, t.users.admin.id);
    assert.equal(row?.dbRole, 'docs_app');
    const after = await t.db.base.user.findUniqueOrThrow({ where: { id: t.users.admin.id } });
    assert.ok(after.lastLoginAt !== null && (before.lastLoginAt === null || after.lastLoginAt > before.lastLoginAt));
  });

  it('validates the body before it reaches the module (400 with the fields)', async () => {
    const res = await t.http.post('/api/v1/auth/login').send({ email: 'not-an-email' });
    assert.equal(res.status, 400);
    assert.equal(bodyOf(res).code, 'VALIDATION_ERROR');
    const fields = bodyOf(res).details.fields.map((f) => f.field);
    assert.ok(fields.includes('email') && fields.includes('password'), fields.join(', '));
  });

  describe('access token validation (A07-A12)', () => {
    const key = () => ({ kid: t.config.jwtKeys[0]!.kid, secret: t.config.jwtKeys[0]!.secret });
    const sign = (over: jwt.SignOptions & { secret?: Buffer; kid?: string } = {}) =>
      jwt.sign({}, over.secret ?? key().secret, {
        algorithm: 'HS256',
        keyid: over.kid ?? key().kid,
        subject: String(t.users.admin.id),
        issuer: 'docs-system-api',
        audience: 'docs-system-web',
        expiresIn: 60,
        ...(over.audience !== undefined ? { audience: over.audience } : {}),
        ...(over.expiresIn !== undefined ? { expiresIn: over.expiresIn } : {}),
      });

    it('A07 no token -> 401 UNAUTHENTICATED', async () => {
      const res = await t.http.get('/api/v1/users');
      assert.equal(bodyOf(res).code, 'UNAUTHENTICATED');
    });
    it('A08 expired token -> 401 TOKEN_EXPIRED', async () => {
      assert.equal(bodyOf(await probe(sign({ expiresIn: -10 }))).code, 'TOKEN_EXPIRED');
    });
    it('A09 token signed with another key -> 401', async () => {
      assert.equal((await probe(sign({ secret: Buffer.alloc(32, 7) }))).status, 401);
    });
    it('A10 alg "none" -> 401', async () => {
      const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const none = `${b64({ alg: 'none', typ: 'JWT', kid: 'test' })}.${b64({ sub: String(t.users.admin.id), iss: 'docs-system-api', aud: 'docs-system-web', exp: 9999999999 })}.`;
      assert.equal((await probe(none)).status, 401);
    });
    it('A11 another audience -> 401', async () => {
      assert.equal((await probe(sign({ audience: 'other-app' }))).status, 401);
    });
    it('unknown kid -> 401', async () => {
      assert.equal((await probe(sign({ kid: 'unknown' }))).status, 401);
    });
    it('A12 a token issued by login passes the gate (no 401/403)', async () => {
      const token = sessionOf(await login(t, EMAILS.admin)).accessToken;
      const res = await probe(token);
      assert.equal(res.status, 404);
      assert.equal(bodyOf(res).details.reason, 'NOT_IMPLEMENTED');
    });
  });

  describe('immediate effect of database changes (D-25)', () => {
    it('A18 a role changed in the database applies to a token already issued', async () => {
      await t.owner.query(`UPDATE app_user SET role = 'DEVELOPER' WHERE id = $1`, [t.users.reader.id]);
      const token = sessionOf(await login(t, EMAILS.reader)).accessToken;
      const post = () => t.http.post('/api/v1/variables').set('Authorization', bearer(token)).send({});
      assert.equal((await post()).status, 400); // passes the gate, then the validator
      await t.owner.query(`UPDATE app_user SET role = 'READER' WHERE id = $1`, [t.users.reader.id]);
      assert.equal((await post()).status, 403);
    });

    it('A20 a user deactivated in the database gets 401 on the next call and cannot refresh', async () => {
      const res = await login(t, EMAILS.developer);
      const token = sessionOf(res).accessToken;
      const read = () => t.http.get('/api/v1/variables?applicationId=1').set('Authorization', bearer(token));
      assert.equal((await read()).status, 404); // passes the gate: NOT_IMPLEMENTED
      await t.owner.query(`UPDATE app_user SET status = 'INACTIVE' WHERE id = $1`, [t.users.developer.id]);
      const after = await read();
      assert.equal(after.status, 401);
      assert.equal(bodyOf(after).code, 'UNAUTHENTICATED');
      const renewed = await refresh(t, rtPair(res));
      assert.equal(renewed.status, 401);
      assert.equal(bodyOf(renewed).code, 'REFRESH_INVALID');
      assert.equal((await login(t, EMAILS.developer)).status, 401);
    });
  });
});
