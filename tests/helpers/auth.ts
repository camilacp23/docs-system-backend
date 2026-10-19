/**
 * Helpers of the authentication tests: real password hashes for the users of `startTestApp`, the reserved account
 * from the real seed function, and small readers of cookies and tokens. Everything runs on the disposable database.
 */
import { loadSeedConfig } from '../../src/config/seed.js';
import { runSeed } from '../../src/db/seed.js';
import { hashPassword } from '../../src/security/passwords.js';
import { testEnv, TEST_ORIGIN, type TestApp } from './app.js';

/** Password of every test user (meets the policy of the contract). */
export const PASSWORD = 'Clave-Segura-2026';

/** E-mails of the users created by `startTestApp` plus the seeded administrator and the reserved account. */
export const EMAILS = {
  admin: 'admin@test.local',
  developer: 'dev@test.local',
  reader: 'reader@test.local',
  inactive: 'inactive@test.local',
  seeded: 'seeded.admin@test.local',
  reserved: 'integracion.jira@system.local',
} as const;

/**
 * Gives every user of `startTestApp` the same real bcrypt hash and seeds the reserved account with `runSeed`.
 *
 * @param t - Application under test.
 */
export async function prepareAuthUsers(t: TestApp): Promise<void> {
  const hash = await hashPassword(PASSWORD);
  await t.owner.query('UPDATE app_user SET password_hash = $1', [hash]);
  await runSeed(
    t.db,
    loadSeedConfig({
      ...testEnv(t.testDb.appUrl),
      SEED_ADMIN_NAME: 'Seeded Admin',
      SEED_ADMIN_EMAIL: EMAILS.seeded,
      SEED_ADMIN_PASSWORD: PASSWORD,
    }),
  );
}

/** Headers `Set-Cookie` of a response. */
export const setCookies = (res: { headers: Record<string, unknown> }): string[] => {
  const value = res.headers['set-cookie'];
  return Array.isArray(value) ? (value as string[]) : [];
};

/** The whole `rt=...; attributes` line of a response, or '' when it has none. */
export const rtLine = (res: { headers: Record<string, unknown> }): string =>
  setCookies(res).find((c) => c.startsWith('rt=')) ?? '';

/** The `rt=value` pair of a response, to send back as a Cookie header. */
export const rtPair = (res: { headers: Record<string, unknown> }): string => rtLine(res).split(';')[0] ?? '';

/** Typed view of a session response body. */
export type SessionBody = {
  data: {
    accessToken: string;
    tokenType: string;
    expiresIn: number;
    sessionExpiresIn: number;
    user: Record<string, unknown> & { id: number };
  };
};
export const sessionOf = (res: { body: unknown }): SessionBody['data'] => (res.body as SessionBody).data;

/** Logs in and returns the response. */
export const login = (t: TestApp, email: string, password: string = PASSWORD) =>
  t.http.post('/api/v1/auth/login').send({ email, password });

/** Refreshes with the given `rt=value` pair and the frontend's Origin. */
export const refresh = (t: TestApp, cookie: string) =>
  t.http.post('/api/v1/auth/refresh').set('Origin', TEST_ORIGIN).set('Cookie', cookie);

/** Logs out with the given `rt=value` pair and the frontend's Origin. */
export const logout = (t: TestApp, cookie: string) =>
  t.http.post('/api/v1/auth/logout').set('Origin', TEST_ORIGIN).set('Cookie', cookie);
