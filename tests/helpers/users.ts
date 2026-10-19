/**
 * Helpers of the users tests: authenticated calls, user fixtures created through the API and the contract's
 * response shapes. Everything runs on the disposable database of `startTestApp`.
 */
import { signAccessToken } from '../../src/security/tokens.js';
import { bearer, type TestApp } from './app.js';
import { EMAILS, PASSWORD } from './auth.js';

/** A user as the API returns it. */
export type UserBody = {
  id: number;
  name: string;
  email: string;
  role: string;
  status: string;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Typed view of a single-user response. */
export const userOf = (res: { body: unknown }): UserBody => (res.body as { data: UserBody }).data;

/** Typed view of the users page. */
export const pageOf = (res: { body: unknown }) =>
  res.body as { data: UserBody[]; page: number; pageSize: number; total: number };

/** Authenticated calls to `/api/v1` with a token. */
export function asUser(t: TestApp, token: string) {
  const auth = (r: ReturnType<TestApp['http']['get']>) => r.set('Authorization', bearer(token));
  return {
    get: (path: string) => auth(t.http.get(`/api/v1${path}`)),
    post: (path: string, body: object) => auth(t.http.post(`/api/v1${path}`)).send(body),
    put: (path: string, body: object, ifMatch?: string) => {
      const r = auth(t.http.put(`/api/v1${path}`));
      return (ifMatch === undefined ? r : r.set('If-Match', ifMatch)).send(body);
    },
    delete: (path: string) => auth(t.http.delete(`/api/v1${path}`)),
  };
}

/** The administrator of `startTestApp` and the seeded one (both ACTIVE ADMINISTRATOR after `prepareAuthUsers`). */
export async function adminsOf(t: TestApp) {
  const seeded = await t.db.base.user.findUniqueOrThrow({ where: { email: EMAILS.seeded } });
  return {
    a: { id: t.users.admin.id, token: t.users.admin.token },
    s: { id: seeded.id, token: signAccessToken(seeded.id) },
  };
}

let counter = 0;

/** Creates a user through `POST /users` as `token` (an administrator) and returns it with its ETag. */
export async function createUser(
  t: TestApp,
  token: string,
  over: Partial<{ name: string; email: string; password: string; role: string }> = {},
) {
  counter += 1;
  const body = {
    name: `Fixture ${counter}`,
    email: `fixture${counter}@test.local`,
    password: PASSWORD,
    role: 'DEVELOPER',
    ...over,
  };
  const res = await asUser(t, token).post('/users', body);
  if (res.status !== 201) throw new Error(`fixture failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { user: userOf(res), email: body.email, token: signAccessToken(userOf(res).id) };
}

/** Number of ACTIVE administrators (read as the owner). */
export async function activeAdmins(t: TestApp): Promise<number> {
  const r = await t.owner.query<{ n: string }>(
    `SELECT count(*) AS n FROM app_user WHERE role = 'ADMINISTRATOR' AND status = 'ACTIVE'`,
  );
  return Number(r.rows[0]!.n);
}
