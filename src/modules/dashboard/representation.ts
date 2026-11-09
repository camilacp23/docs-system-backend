/**
 * The indicators as the contract serves them (`IndicatorsEnvelope.data`, FR-19, D-106). Pure: it turns the counts the
 * repository read into the response; it never reads the database.
 *
 * @module modules/dashboard/representation
 */
import { approvedPercent } from './percent.js';

/** The five documentation statuses, in the order of the contract. */
export const DOCUMENTATION_STATUSES = ['UNDOCUMENTED', 'DRAFT', 'IN_PROGRESS', 'IN_REVIEW', 'APPROVED'] as const;

/** One documentation status. */
export type DocumentationStatus = (typeof DOCUMENTATION_STATUSES)[number];

/** The counts of one application, as one statement of the repository returns them. */
export type IndicatorRow = {
  byStatus: Record<DocumentationStatus, number>;
  variablesTotal: number;
  variablesUntraced: number;
  collectionsTotal: number;
  collectionsUndocumented: number;
  pendingSubtasks: number;
  lastSyncedAt: Date | null;
};

/** A recent activity record as the audit service gives it (the dashboard does not look inside). */
export type ActivityItem = object;

/** `data` of the response. `recentActivity` is absent, never null, for a Reader. */
export type Indicators = {
  documentation: {
    totalScreens: number;
    byStatus: Record<DocumentationStatus, number>;
    approvedPercent: number;
  };
  variables: { total: number; untraced: number };
  collections: { total: number; undocumented: number };
  jira: { pendingSubtasks: number; jiraAvailable: boolean; lastSyncedAt: string | null };
  recentActivity?: ActivityItem[];
};

/**
 * Builds the response.
 *
 * @param row - The counts read from the database.
 * @param jiraAvailable - The state of the Jira client (configured and circuit not open); Jira is never asked.
 * @param recentActivity - The recent activity, or `undefined` for a role that does not receive it (the key is then
 *   left out of the response).
 */
export function toIndicators(row: IndicatorRow, jiraAvailable: boolean, recentActivity?: ActivityItem[]): Indicators {
  const byStatus: Record<DocumentationStatus, number> = {
    UNDOCUMENTED: row.byStatus.UNDOCUMENTED,
    DRAFT: row.byStatus.DRAFT,
    IN_PROGRESS: row.byStatus.IN_PROGRESS,
    IN_REVIEW: row.byStatus.IN_REVIEW,
    APPROVED: row.byStatus.APPROVED,
  };
  const totalScreens = DOCUMENTATION_STATUSES.reduce((sum, status) => sum + byStatus[status], 0);
  return {
    documentation: { totalScreens, byStatus, approvedPercent: approvedPercent(byStatus.APPROVED, totalScreens) },
    variables: { total: row.variablesTotal, untraced: row.variablesUntraced },
    collections: { total: row.collectionsTotal, undocumented: row.collectionsUndocumented },
    jira: {
      pendingSubtasks: row.pendingSubtasks,
      jiraAvailable,
      lastSyncedAt: row.lastSyncedAt === null ? null : row.lastSyncedAt.toISOString(),
    },
    ...(recentActivity === undefined ? {} : { recentActivity }),
  };
}
