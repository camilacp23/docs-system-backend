/**
 * Helpers of the applications tests: the contract's response shapes and application fixtures created through the
 * API. Everything runs on the disposable database of `startTestApp`.
 */
import type { TestApp } from './app.js';
import { asUser } from './users.js';

/** An application as the API returns it. */
export type ApplicationBody = {
  id: number;
  name: string;
  description: string | null;
  platform: string;
  jiraProjectKey: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  appContextScreen: { id: number; name: string };
  createdBy: { id: number; name: string };
  createdAt: string;
  updatedAt: string;
};

/** Typed view of a single-application response. */
export const applicationOf = (res: { body: unknown }): ApplicationBody => (res.body as { data: ApplicationBody }).data;

/** Typed view of the applications page. */
export const applicationsPageOf = (res: { body: unknown }) =>
  res.body as { data: ApplicationBody[]; page: number; pageSize: number; total: number };

let counter = 0;

/** A unique application name for the disposable database. */
export const uniqueName = (prefix = 'App'): string => `${prefix} ${(counter += 1)}`;

/** Creates an application through `POST /applications` as `token` (an administrator) and returns it with its ETag. */
export async function createApplication(
  t: TestApp,
  token: string,
  over: Partial<{ name: string; description: string | null; platform: string; jiraProjectKey: string | null }> = {},
) {
  const body = { name: uniqueName(), platform: 'Power Apps', ...over };
  const res = await asUser(t, token).post('/applications', body);
  if (res.status !== 201) throw new Error(`fixture failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { application: applicationOf(res), etag: res.headers.etag as string };
}

/** The body of a `PUT /applications/{id}` that changes nothing, with optional overrides. */
export const putBodyOf = (a: ApplicationBody, over: object = {}) => ({
  name: a.name,
  description: a.description,
  platform: a.platform,
  jiraProjectKey: a.jiraProjectKey,
  status: a.status,
  ...over,
});
