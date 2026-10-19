/**
 * A full session (login, refresh, reuse, logout, failures, 429) leaves no password, token or cookie in the logs
 * (NFR-06, CLAUDE.md rule 7).
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { EMAILS, login, logout, PASSWORD, prepareAuthUsers, refresh, rtPair, sessionOf } from '../helpers/auth.js';

describe('logs of the authentication flow', () => {
  let t: TestApp;
  before(async () => {
    t = await startTestApp();
    await prepareAuthUsers(t);
  });
  after(async () => {
    await t.close();
  });

  it('never contain the password, the access token, the refresh token or the cookie', async () => {
    const wrongPassword = 'Otra-Clave-Equivocada-77';
    const first = await login(t, EMAILS.admin);
    const accessTokens = [sessionOf(first).accessToken];
    const cookies = [rtPair(first)];
    const second = await refresh(t, cookies[0]!);
    accessTokens.push(sessionOf(second).accessToken);
    cookies.push(rtPair(second));
    await refresh(t, cookies[0]!); // reuse -> 401
    await login(t, EMAILS.admin, wrongPassword); // 401
    for (let i = 0; i < 6; i++) await login(t, EMAILS.reader, wrongPassword); // ... and a 429
    await logout(t, cookies[1]!);

    const out = t.logs.join('\n');
    assert.ok(out.includes('"statusCode":200') && out.includes('"statusCode":401') && out.includes('"statusCode":429'));
    for (const secret of [PASSWORD, wrongPassword, ...accessTokens, ...cookies.map((c) => c.slice(3)), ...cookies]) {
      assert.ok(!out.includes(secret), `a secret of ${secret.length} characters reached the log`);
    }
  });
});
