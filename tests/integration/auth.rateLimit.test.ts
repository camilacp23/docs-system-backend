/**
 * Rate limits of /auth (NFR-05, D-27, D-60): login 5 failures per IP + e-mail; refresh and logout 30 per cookie
 * fingerprint, each with its own counter. `Retry-After` and `details.minutes` come from the same calculation.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { bodyOf, startTestApp, TEST_ORIGIN, type TestApp } from '../helpers/app.js';
import { EMAILS, login, PASSWORD, prepareAuthUsers } from '../helpers/auth.js';

describe('rate limits of /auth', () => {
  let t: TestApp;
  before(async () => {
    t = await startTestApp();
    await prepareAuthUsers(t);
  });
  after(async () => {
    await t.close();
  });

  const expectLimited = (res: { status: number; headers: Record<string, unknown>; body: unknown }) => {
    assert.equal(res.status, 429);
    const body = bodyOf(res);
    assert.equal(body.code, 'RATE_LIMITED');
    const seconds = Number(res.headers['retry-after']);
    assert.ok(Number.isInteger(seconds) && seconds >= 1 && seconds <= 15 * 60, String(res.headers['retry-after']));
    const minutes = (body.details as unknown as { minutes: number }).minutes;
    assert.equal(
      minutes,
      Math.max(1, Math.ceil(seconds / 60)),
      'details.minutes and Retry-After share one calculation',
    );
    assert.equal(body.message, `Too many attempts. Try again in ${minutes} minutes.`);
    assert.ok(typeof res.headers['x-request-id'] === 'string');
  };

  it('A22 the sixth failed login for an IP + e-mail in 15 minutes -> 429, even with the right password', async () => {
    for (let i = 1; i <= 5; i++) {
      const res = await login(t, EMAILS.reader, 'mala-clave-xx');
      assert.equal(res.status, 401, `attempt ${i}`);
    }
    expectLimited(await login(t, EMAILS.reader, 'mala-clave-xx'));
    expectLimited(await login(t, 'READER@test.local', PASSWORD));
  });

  it('the limit is per e-mail: another e-mail from the same IP still works', async () => {
    assert.equal((await login(t, EMAILS.developer)).status, 200);
  });

  it('successful logins are not counted', async () => {
    for (let i = 0; i < 8; i++) assert.equal((await login(t, EMAILS.admin)).status, 200);
  });

  it('D-60 refresh: the 31st request with the same cookie -> 429; another cookie is not affected', async () => {
    const cookie = 'rt=cookie-of-one-client';
    for (let i = 1; i <= 30; i++) {
      const res = await t.http.post('/api/v1/auth/refresh').set('Origin', TEST_ORIGIN).set('Cookie', cookie);
      assert.equal(res.status, 401, `request ${i}`);
    }
    expectLimited(await t.http.post('/api/v1/auth/refresh').set('Origin', TEST_ORIGIN).set('Cookie', cookie));
    const other = await t.http
      .post('/api/v1/auth/refresh')
      .set('Origin', TEST_ORIGIN)
      .set('Cookie', 'rt=another-client');
    assert.equal(other.status, 401);
  });

  it('D-60 logout has its own counter: an exhausted refresh does not block logout, and logout limits at 31', async () => {
    const cookie = 'rt=cookie-of-one-client';
    const out = () => t.http.post('/api/v1/auth/logout').set('Origin', TEST_ORIGIN).set('Cookie', cookie);
    for (let i = 1; i <= 30; i++) assert.equal((await out()).status, 204, `request ${i}`);
    expectLimited(await out());
  });

  it('without a cookie the key is the IP alone', async () => {
    for (let i = 1; i <= 30; i++) {
      assert.equal((await t.http.post('/api/v1/auth/refresh').set('Origin', TEST_ORIGIN)).status, 401, `request ${i}`);
    }
    expectLimited(await t.http.post('/api/v1/auth/refresh').set('Origin', TEST_ORIGIN));
  });
});
