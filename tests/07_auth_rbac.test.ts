/**
 * Authentication + authorization tests (SDD Section 11), as the API role docs_app.
 *   APP_URL=postgresql://docs_app:***@localhost:5432/<copy> OPENAPI=../api/openapi.yaml \
 *   JWT_KEYS="k1:<base64 32+ bytes>" FRONTEND_ORIGIN=https://docs.local \
 *   INTEGRATION_USER_EMAIL=integracion.jira@system.local npx tsx tests/07_auth_rbac.test.ts
 */
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createPrisma } from '../src/db/prisma.js';
import { buildApp } from '../src/security/testApp.js';
import { hashPassword } from '../src/security/passwords.js';
import { security } from '../src/security/config.js';

const db = createPrisma(process.env.APP_URL!);
const { app, policies } = buildApp(db, process.env.OPENAPI!);
const ORIGIN = security.allowedOrigin;
let fail = 0;
const check = (label: string, ok: boolean, detail = '') => { if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' ' + detail : ''}`); };
const PW = 'Clave-Segura-2026';
const login = (email: string, password = PW) => request(app).post('/api/v1/auth/login').send({ email, password });
const cookieOf = (res: any) => (res.headers['set-cookie'] ?? []).find((c: string) => c.startsWith('rt=')) ?? '';
const rt = (cookie: string) => cookie.split(';')[0];

async function main() {
  const hash = await hashPassword(PW);
  const mk = (name: string, email: string, role: string, status = 'ACTIVE') => db.base.user.create({ data: { name, email, passwordHash: hash, role, status } });
  const admin = await mk('Admin', 'admin@dept.local', 'ADMINISTRATOR');
  const dev = await mk('Dev', 'dev@dept.local', 'DEVELOPER');
  const reader = await mk('Lector', 'lector@dept.local', 'READER');
  await mk('Integración Jira', 'integracion.jira@system.local', 'READER', 'INACTIVE');
  await mk('Inactivo', 'inactivo@dept.local', 'DEVELOPER', 'INACTIVE');
  const victim = await mk('Dev2', 'dev2@dept.local', 'DEVELOPER');

  // ---------------- login
  const ok = await login('Admin@Dept.local');
  const c = cookieOf(ok);
  check('A01 login returns access token, user, and refresh cookie', ok.status === 200 && !!ok.body.data.accessToken && ok.body.data.user.id === admin.id && ok.body.data.expiresIn === 28800);
  check('A02 refresh cookie is HttpOnly, Secure, SameSite=Strict, Path=/api/v1/auth', /HttpOnly/.test(c) && /Secure/.test(c) && /SameSite=Strict/.test(c) && /Path=\/api\/v1\/auth/.test(c), `(${c.split(';').slice(1).join(';').trim()})`);
  const claims: any = jwt.decode(ok.body.data.accessToken, { complete: true });
  check('A03 JWT: HS256 with kid, iss/aud, 8 h expiry, no role claim', claims.header.alg === 'HS256' && !!claims.header.kid && claims.payload.iss === security.issuer && claims.payload.exp - claims.payload.iat === 28800 && !('role' in claims.payload));
  const wrong = await login('admin@dept.local', 'incorrecta-123'), unknown = await login('nadie@dept.local'), inactive = await login('inactivo@dept.local');
  check('A04 wrong password, unknown e-mail, inactive account: same 401 INVALID_CREDENTIALS',
    [wrong, unknown, inactive].every((r) => r.status === 401 && r.body.code === 'INVALID_CREDENTIALS') && JSON.stringify(wrong.body) === JSON.stringify(unknown.body));
  check('A05 integration account cannot log in', (await login('integracion.jira@system.local')).status === 401);
  const lastLogin = await db.base.auditLog.findFirst({ where: { entityType: 'app_user', entityId: String(admin.id), changedFields: { has: 'last_login_at' } } });
  check('A06 login audited with the user as actor', lastLogin?.actorUserId === admin.id);

  // ---------------- access token validation
  const adminTok = ok.body.data.accessToken;
  const call = (tok: string | null) => { const r = request(app).get('/api/v1/users'); return tok ? r.set('Authorization', `Bearer ${tok}`) : r; };
  check('A07 no token -> 401 UNAUTHENTICATED', (await call(null)).body.code === 'UNAUTHENTICATED');
  const key = security.keys[0];
  const expired = jwt.sign({}, key.secret, { algorithm: 'HS256', keyid: key.kid, subject: String(admin.id), issuer: security.issuer, audience: security.audience, expiresIn: -10 });
  check('A08 expired token -> 401 TOKEN_EXPIRED', (await call(expired)).body.code === 'TOKEN_EXPIRED');
  const forged = jwt.sign({}, Buffer.alloc(32, 7), { algorithm: 'HS256', keyid: key.kid, subject: String(admin.id), issuer: security.issuer, audience: security.audience, expiresIn: 60 });
  check('A09 token signed with another key -> 401', (await call(forged)).status === 401);
  const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const none = `${b64({ alg: 'none', typ: 'JWT', kid: key.kid })}.${b64({ sub: String(admin.id), iss: security.issuer, aud: security.audience, exp: 9999999999 })}.`;
  check('A10 alg "none" token -> 401', (await call(none)).status === 401);
  const otherAud = jwt.sign({}, key.secret, { algorithm: 'HS256', keyid: key.kid, subject: String(admin.id), issuer: security.issuer, audience: 'other-app', expiresIn: 60 });
  check('A11 token for another audience -> 401', (await call(otherAud)).status === 401);
  check('A12 valid token -> 200', (await call(adminTok)).status === 200);

  // ---------------- refresh rotation and reuse detection
  const r1 = await request(app).post('/api/v1/auth/refresh').set('Origin', ORIGIN).set('Cookie', rt(c));
  const c2 = cookieOf(r1);
  check('A13 refresh returns a new access token and a NEW refresh cookie', r1.status === 200 && !!r1.body.data.accessToken && rt(c2) !== rt(c));
  const reuse = await request(app).post('/api/v1/auth/refresh').set('Origin', ORIGIN).set('Cookie', rt(c));
  const afterReuse = await request(app).post('/api/v1/auth/refresh').set('Origin', ORIGIN).set('Cookie', rt(c2));
  check('A14 reusing a rotated token -> 401 and the whole family is revoked', reuse.body.code === 'REFRESH_INVALID' && afterReuse.status === 401);
  const crossSite = await request(app).post('/api/v1/auth/refresh').set('Origin', 'https://evil.example').set('Cookie', rt(c2));
  check('A15 refresh from another Origin -> 403', crossSite.status === 403);
  const d = await login('dev@dept.local'); const dc = cookieOf(d);
  const out = await request(app).post('/api/v1/auth/logout').set('Origin', ORIGIN).set('Cookie', rt(dc));
  const afterLogout = await request(app).post('/api/v1/auth/refresh').set('Origin', ORIGIN).set('Cookie', rt(dc));
  check('A16 logout -> 204 and the refresh token no longer works', out.status === 204 && afterLogout.status === 401);
  const rows = await db.base.refreshToken.findMany({ select: { tokenHash: true } });
  check('A17 refresh tokens stored only as SHA-256 hashes', rows.length > 0 && rows.every((r: any) => /^[0-9a-f]{64}$/.test(r.tokenHash)) && !rows.some((r: any) => r.tokenHash === rt(c).slice(3)));

  // ---------------- immediate effect of role change and deactivation (D-25)
  const v = await login('dev2@dept.local'); const vTok = v.body.data.accessToken; const vCookie = cookieOf(v);
  const before = await request(app).post('/api/v1/variables').set('Authorization', `Bearer ${vTok}`).send({});
  const fresh = (await login('admin@dept.local')).body.data.accessToken;
  await request(app).put(`/api/v1/users/${victim.id}/role`).set('Authorization', `Bearer ${fresh}`).send({ role: 'READER' });
  const after = await request(app).post('/api/v1/variables').set('Authorization', `Bearer ${vTok}`).send({});
  check('A18 role change applies to an already-issued token (200 -> 403)', before.status === 200 && after.status === 403, `(${before.status} -> ${after.status})`);
  check('A19 role change revokes the user\'s refresh tokens', (await request(app).post('/api/v1/auth/refresh').set('Origin', ORIGIN).set('Cookie', rt(vCookie))).status === 401);
  await request(app).delete(`/api/v1/users/${victim.id}`).set('Authorization', `Bearer ${fresh}`);
  check('A20 deactivation applies to an already-issued token (-> 401)', (await request(app).get('/api/v1/variables').set('Authorization', `Bearer ${vTok}`)).status === 401);
  check('A21 an administrator cannot deactivate themself', (await request(app).delete(`/api/v1/users/${admin.id}`).set('Authorization', `Bearer ${fresh}`)).body.code === 'CANNOT_DEACTIVATE_SELF');

  // ---------------- rate limit
  let last: any; for (let i = 0; i < 6; i++) last = await login('lector@dept.local', 'mala-clave-xx');
  check('A22 sixth failed login in 15 min -> 429 RATE_LIMITED', last.status === 429 && last.body.code === 'RATE_LIMITED');

  // ---------------- full RBAC matrix from the contract
  const tokens: Record<string, { tok: string; id: number }> = {
    ADMINISTRATOR: { tok: (await login('admin@dept.local')).body.data.accessToken, id: admin.id },
    DEVELOPER: { tok: (await login('dev@dept.local')).body.data.accessToken, id: dev.id },
    READER: { tok: (await request(app).post('/api/v1/auth/login').set('X-Forwarded-For', '10.0.0.9').send({ email: 'lector@dept.local', password: PW })).body.data?.accessToken, id: reader.id },
  };
  if (!tokens.READER.tok) { // the reader's own e-mail is rate limited from A22; log in through a fresh key
    tokens.READER.tok = jwt.sign({}, key.secret, { algorithm: 'HS256', keyid: key.kid, subject: String(reader.id), issuer: security.issuer, audience: security.audience, expiresIn: 600 });
  }
  let checks = 0, wrongOnes: string[] = [];
  for (const p of policies.values()) {
    if (p.roles.length === 0) continue;                                     // public, cookie, or signature
    if (['changeUserRole', 'deactivateUser'].includes(p.operationId)) continue; // real handlers, tested above
    for (const role of ['ADMINISTRATOR', 'DEVELOPER', 'READER']) {
      const url = p.expressPath.replace(':type', 'screens').replace(':id', '999');
      const res = await (request(app) as any)[p.method.toLowerCase()](url).set('Authorization', `Bearer ${tokens[role].tok}`).send({});
      const allowed = p.roles.includes(role as any);
      checks++;
      if ((allowed && res.status !== 200) || (!allowed && res.status !== 403)) wrongOnes.push(`${role} ${p.method} ${p.path} -> ${res.status}`);
    }
  }
  check(`A23 RBAC matrix: every operation x every role enforced as declared in the contract`, wrongOnes.length === 0, `(${checks} checks${wrongOnes.length ? ': ' + wrongOnes.join('; ') : ''})`);
  const self = await request(app).get(`/api/v1/users/${dev.id}`).set('Authorization', `Bearer ${tokens.DEVELOPER.tok}`);
  const other = await request(app).get(`/api/v1/users/${admin.id}`).set('Authorization', `Bearer ${tokens.DEVELOPER.tok}`);
  check('A24 GET /users/:id: a non-admin can read only their own user (SELF_OR_ROLE)', self.status === 200 && other.status === 403);
  check('A25 every contract operation has x-roles (fail-closed loading)', policies.size === 50, `(${policies.size} operations)`);

  // ---------------- absolute 12 h session (confirmed by the department)
  const s1 = await request(app).post('/api/v1/auth/login').set('X-Forwarded-For', '10.0.0.20').send({ email: 'dev@dept.local', password: PW });
  const sc1 = cookieOf(s1);
  const row1 = await db.base.refreshToken.findFirst({ where: { userId: dev.id, revokedAt: null }, orderBy: { id: 'desc' } });
  const hours = (row1!.expiresAt.getTime() - row1!.createdAt.getTime()) / 3600000;
  check('A26 session ends 12 h after login', Math.abs(hours - 12) < 0.01, `(${hours.toFixed(2)} h)`);
  const s2 = await request(app).post('/api/v1/auth/refresh').set('Origin', ORIGIN).set('Cookie', rt(sc1));
  const row2 = await db.base.refreshToken.findFirst({ where: { userId: dev.id, revokedAt: null }, orderBy: { id: 'desc' } });
  check('A27 rotation keeps the same end (never extends the session)', s2.status === 200 && row2!.id !== row1!.id && row2!.expiresAt.getTime() === row1!.expiresAt.getTime());
  check('A28 refresh cookie expires with the session', new Date(/Expires=([^;]+)/.exec(cookieOf(s2))![1]).getTime() === Math.floor(row1!.expiresAt.getTime() / 1000) * 1000);
  await db.base.refreshToken.update({ where: { id: row2!.id }, data: { createdAt: new Date(Date.now() - 13 * 3600000), expiresAt: new Date(Date.now() - 3600000) } });
  const late = await request(app).post('/api/v1/auth/refresh').set('Origin', ORIGIN).set('Cookie', rt(cookieOf(s2)));
  check('A29 refresh after the 12 h end -> 401 REFRESH_INVALID (log in again)', late.status === 401 && late.body.code === 'REFRESH_INVALID');

  // ---------------- CP-06: reserved integration account (INTEGRATION_USER_EMAIL)
  const reserved = await db.base.user.findUnique({ where: { email: security.integrationUserEmail } });
  const adm = tokens.ADMINISTRATOR.tok;
  const asAdmin = (r: any) => r.set('Authorization', `Bearer ${adm}`);
  const intLogin = await request(app).post('/api/v1/auth/login').set('X-Forwarded-For', '10.0.0.30').send({ email: security.integrationUserEmail, password: PW });
  const nobody = await request(app).post('/api/v1/auth/login').set('X-Forwarded-For', '10.0.0.30').send({ email: 'nadie2@dept.local', password: PW });
  check('A30 login with the integration e-mail -> the standard 401 INVALID_CREDENTIALS',
    !!reserved && intLogin.status === 401 && intLogin.body.code === 'INVALID_CREDENTIALS' && JSON.stringify(intLogin.body) === JSON.stringify(nobody.body),
    `(${intLogin.body.message})`);
  const put = await asAdmin(request(app).put(`/api/v1/users/${reserved!.id}`)).send({ name: 'X', email: 'x@dept.local', status: 'ACTIVE' });
  check('A31 PUT /users/{id} on the reserved account -> 422 RESERVED_ACCOUNT', put.status === 422 && put.body.code === 'RESERVED_ACCOUNT', `(${put.body.message})`);
  const role = await asAdmin(request(app).put(`/api/v1/users/${reserved!.id}/role`)).send({ role: 'ADMINISTRATOR' });
  const roleAfter = await db.base.user.findUnique({ where: { id: reserved!.id } });
  check('A32 PUT /users/{id}/role on the reserved account -> 422 RESERVED_ACCOUNT (role unchanged)',
    role.status === 422 && role.body.code === 'RESERVED_ACCOUNT' && roleAfter!.role === 'READER');
  const del = await asAdmin(request(app).delete(`/api/v1/users/${reserved!.id}`));
  check('A33 DELETE /users/{id} on the reserved account -> 422 RESERVED_ACCOUNT', del.status === 422 && del.body.code === 'RESERVED_ACCOUNT');
  const list = await asAdmin(request(app).get('/api/v1/users?pageSize=100'));
  const allUsers = await db.base.user.count();
  check('A34 GET /users never lists the reserved account (total excludes it)',
    list.status === 200 && !list.body.data.some((u: any) => u.email === security.integrationUserEmail) && list.body.total === allUsers - 1,
    `(${list.body.total} of ${allUsers})`);
  const one = await asAdmin(request(app).get(`/api/v1/users/${reserved!.id}`));
  check('A35 GET /users/{id} of the reserved account -> 404 NOT_FOUND', one.status === 404 && one.body.code === 'NOT_FOUND', `(${one.body.message})`);
}
main().catch((e) => { fail++; console.error('FAIL  unexpected', e); })
  .finally(async () => { await db.prisma.$disconnect(); console.log(fail === 0 ? 'ALL PASSED' : `${fail} FAILURE(S)`); process.exit(fail ? 1 : 0); });
