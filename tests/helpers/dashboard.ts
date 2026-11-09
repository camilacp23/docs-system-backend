/**
 * Helpers of the dashboard tests: the shape of the response and a call to `GET /dashboard/indicators` that must answer
 * 200 and conform to the contract (every variant). Everything runs on the disposable database of `startTestApp`.
 */
import assert from 'node:assert/strict';
import { assertConformsToContract } from './contractResponse.js';
import type { TestApp } from './app.js';
import { asUser } from './users.js';

/** A recent activity record as the API returns it. */
export type ActivityBody = {
  actor: { id: number; name: string } | null;
  action: string;
  eventName: string | null;
  entityType: string;
  entityId: string;
  entityLabel: string | null;
  createdAt: string;
};

/** `data` of the response. */
export type IndicatorsBody = {
  documentation: {
    totalScreens: number;
    byStatus: Record<'UNDOCUMENTED' | 'DRAFT' | 'IN_PROGRESS' | 'IN_REVIEW' | 'APPROVED', number>;
    approvedPercent: number;
  };
  variables: { total: number; untraced: number };
  collections: { total: number; undocumented: number };
  jira: { pendingSubtasks: number; jiraAvailable: boolean; lastSyncedAt: string | null };
  recentActivity?: ActivityBody[];
};

/** Typed view of a 200 response. */
export const indicatorsOf = (res: { body: unknown }): IndicatorsBody => (res.body as { data: IndicatorsBody }).data;

/** `GET /dashboard/indicators` as `token`. */
export const getIndicators = (t: TestApp, applicationId: number | string, token = t.users.admin.token) =>
  asUser(t, token).get(`/dashboard/indicators?applicationId=${applicationId}`);

/** `GET /dashboard/indicators` that must answer 200 and conform to the contract; returns `data`. */
export async function indicatorsOk(
  t: TestApp,
  applicationId: number,
  token = t.users.admin.token,
): Promise<IndicatorsBody> {
  const res = await getIndicators(t, applicationId, token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await assertConformsToContract(res);
  return indicatorsOf(res);
}
