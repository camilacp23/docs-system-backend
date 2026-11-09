/**
 * Refresh rotation, reuse detection, logout and the absolute 12 h session (NFR-01, SDD 11.2, D-38, D-61).
 * Equivalents of A13-A17 and A26-A29 of test 07, plus the race of two refreshes with the same cookie.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, describe, it } from 'node:test';
import { bodyOf, startTestApp, TEST_ORIGIN, type TestApp } from '../helpers/app.js';
import { EMAILS, login, logout, prepareAuthUsers, refresh, rtLine, rtPair, sessionOf } from '../helpers/auth.js';

describe('refresh, logout and session end', () => {
  let t: TestApp;
  before(async () => {
    t = await startTestApp();
    await prepareAuthUsers(t);
  });
  after(async () => {
    await t.close();
  });

  const tokenRows = async (userId: number) =>
    (
      await t.owner.query<{
        id: string;
        token_hash: string;
        family_id: string;
        expires_at: Date;
        created_at: Date;
        revoked_at: Date | null;
      }>(
        'SELECT id, token_hash, family_id, expires_at, created_at, revoked_at FROM refresh_token WHERE user_id = $1 ORDER BY id',
        [userId],
      )
    ).rows;

  it('A13 refresh returns a new access token, sessionExpiresIn and a NEW cookie', async () => {
    const first = await login(t, EMAILS.admin);
    const res = await refresh(t, rtPair(first));
    assert.equal(res.status, 200);
    assert.equal(sessionOf(res).tokenType, 'Bearer');
    assert.ok(sessionOf(res).accessToken.length > 20);
    assert.ok(Number.isInteger(sessionOf(res).sessionExpiresIn));
    assert.equal(sessionOf(res).user.id, t.users.admin.id);
    assert.notEqual(rtPair(res), rtPair(first));
    assert.match(rtLine(res), /HttpOnly.*Secure|Secure.*HttpOnly/);
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  it('A14 reusing a rotated token -> 401 REFRESH_INVALID and the whole family is revoked', async () => {
    const first = await login(t, EMAILS.reader);
    const second = await refresh(t, rtPair(first));
    assert.equal(second.status, 200);
    const reuse = await refresh(t, rtPair(first));
    assert.equal(reuse.status, 401);
    assert.equal(bodyOf(reuse).code, 'REFRESH_INVALID');
    const afterReuse = await refresh(t, rtPair(second));
    assert.equal(afterReuse.status, 401);
    const rows = await tokenRows(t.users.reader.id);
    assert.ok(rows.length >= 2 && rows.every((r) => r.revoked_at !== null));
  });

  it('two refreshes at once with the same cookie: one 200, one 401, and the new cookie is revoked too (D-38)', async () => {
    const first = await login(t, EMAILS.admin);
    const cookie = rtPair(first);
    const [a, b] = await Promise.all([refresh(t, cookie), refresh(t, cookie)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 401]);
    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    assert.equal(bodyOf(loser).code, 'REFRESH_INVALID');
    const next = await refresh(t, rtPair(winner));
    assert.equal(next.status, 401);
    assert.equal(bodyOf(next).code, 'REFRESH_INVALID');
  });

  it('refresh and logout accept only the frontend Origin: another one or none -> 403 FORBIDDEN, reason ORIGIN', async () => {
    const cookie = rtPair(await login(t, EMAILS.admin));
    for (const op of ['refresh', 'logout']) {
      for (const origin of [undefined, 'https://evil.example']) {
        const req = t.http.post(`/api/v1/auth/${op}`).set('Cookie', cookie);
        const res = await (origin === undefined ? req : req.set('Origin', origin));
        assert.equal(res.status, 403, `${op} ${origin}`);
        assert.deepEqual(bodyOf(res), {
          code: 'FORBIDDEN',
          message: "This request's origin isn't allowed.",
          details: { reason: 'ORIGIN' },
        });
      }
    }
    // The rejected requests did not consume the token.
    assert.equal((await refresh(t, cookie)).status, 200);
  });

  it('a missing, malformed or unknown cookie -> 401 REFRESH_INVALID', async () => {
    const none = await t.http.post('/api/v1/auth/refresh').set('Origin', TEST_ORIGIN);
    assert.equal(none.status, 401);
    assert.equal(bodyOf(none).code, 'REFRESH_INVALID');
    assert.equal((await refresh(t, 'rt=not-a-real-token')).status, 401);
  });

  it('A15 refresh and logout from another Origin, or without Origin -> 403 before anything else', async () => {
    const first = await login(t, EMAILS.admin);
    for (const path of ['/api/v1/auth/refresh', '/api/v1/auth/logout']) {
      const foreign = await t.http.post(path).set('Origin', 'https://evil.example').set('Cookie', rtPair(first));
      assert.equal(foreign.status, 403, path);
      assert.equal((await t.http.post(path).set('Cookie', rtPair(first))).status, 403, path);
    }
    assert.equal((await refresh(t, rtPair(first))).status, 200, 'the cookie was not consumed by the rejected calls');
  });

  it('A16 logout -> 204, the cookie is cleared and the refresh token stops working; it is idempotent', async () => {
    const first = await login(t, EMAILS.developer);
    const out = await logout(t, rtPair(first));
    assert.equal(out.status, 204);
    const cleared = rtLine(out);
    assert.match(cleared, /^rt=;/);
    assert.match(cleared, /Path=\/api\/v1\/auth/);
    assert.match(cleared, /Expires=Thu, 01 Jan 1970/);
    assert.equal((await refresh(t, rtPair(first))).status, 401);
    assert.equal((await logout(t, rtPair(first))).status, 204);
    assert.equal((await t.http.post('/api/v1/auth/logout').set('Origin', TEST_ORIGIN)).status, 204);
  });

  it('logout revokes the whole family, including the latest rotated token', async () => {
    const first = await login(t, EMAILS.admin);
    const second = await refresh(t, rtPair(first));
    assert.equal((await logout(t, rtPair(second))).status, 204);
    assert.equal((await refresh(t, rtPair(second))).status, 401);
  });

  it('A17 refresh tokens are stored only as SHA-256 hashes', async () => {
    const res = await login(t, EMAILS.admin);
    const raw = rtPair(res).slice(3);
    const rows = await tokenRows(t.users.admin.id);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash)));
    assert.ok(!rows.some((r) => r.token_hash === raw));
  });

  describe('absolute session of 12 h', () => {
    it('A26-A28 ends 12 h after login, rotation keeps the same end and the cookie expires with it', async () => {
      const first = await login(t, EMAILS.reader);
      // the reader's earlier family was revoked in A14: the live rows are the newest ones
      const rowsFirst = (await tokenRows(t.users.reader.id)).filter((r) => r.revoked_at === null);
      const row1 = rowsFirst.at(-1)!;
      const hours = (row1.expires_at.getTime() - row1.created_at.getTime()) / 3_600_000;
      assert.ok(Math.abs(hours - 12) < 0.01, `${hours.toFixed(3)} h`);

      const second = await refresh(t, rtPair(first));
      assert.equal(second.status, 200);
      const live = (await tokenRows(t.users.reader.id)).filter((r) => r.revoked_at === null);
      assert.equal(live.length, 1);
      assert.notEqual(live[0]!.id, row1.id);
      assert.equal(live[0]!.expires_at.getTime(), row1.expires_at.getTime());
      assert.equal(live[0]!.family_id, row1.family_id);
      const expires = new Date(/Expires=([^;]+)/.exec(rtLine(second))![1]!).getTime();
      assert.equal(expires, Math.floor(row1.expires_at.getTime() / 1000) * 1000);
    });

    it('sessionExpiresIn is at most 43200 and never grows across refreshes (D-61)', async () => {
      const first = await login(t, EMAILS.seeded);
      assert.equal(first.status, 200);
      const values = [sessionOf(first).sessionExpiresIn];
      let cookie = rtPair(first);
      for (let i = 0; i < 3; i++) {
        await sleep(1100);
        const res = await refresh(t, cookie);
        assert.equal(res.status, 200);
        values.push(sessionOf(res).sessionExpiresIn);
        cookie = rtPair(res);
      }
      assert.ok(
        values.every((v) => Number.isInteger(v) && v > 0 && v <= 43200),
        values.join(','),
      );
      for (let i = 1; i < values.length; i++) assert.ok(values[i]! < values[i - 1]!, values.join(','));
    });

    it('A29 refresh after the end of the session -> 401 REFRESH_INVALID', async () => {
      const first = await login(t, EMAILS.admin);
      const second = await refresh(t, rtPair(first));
      await t.owner.query(
        `UPDATE refresh_token SET created_at = now() - interval '13 hours', expires_at = now() - interval '1 hour'
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [t.users.admin.id],
      );
      const late = await refresh(t, rtPair(second));
      assert.equal(late.status, 401);
      assert.equal(bodyOf(late).code, 'REFRESH_INVALID');
    });
  });
});
