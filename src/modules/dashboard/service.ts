/**
 * Rules of the indicator dashboard (FR-19; D-106). Read only. The service never sees req/res.
 *
 * Order of the answers: the role gate (x-roles) and the contract validator run before this code, so a missing
 * `applicationId` is 400 first. Here come the range of the id and the existence of the application (404), and then
 * the indicators. `READER_OVERVIEW`: only an Administrator or a Developer receives `recentActivity`; for a Reader the
 * audit query is not even run. The role is the caller's, read from the database by the authentication chain.
 *
 * Jira is never called: `jiraAvailable` is the state of the client (configured, circuit not open).
 *
 * @module modules/dashboard/service
 */
import { assertIdInRange } from '../../http/ids.js';
import type { JiraClient } from '../../integrations/jira/index.js';
import { E } from '../../security/errors.js';
import type { AuditService } from '../audit/service.js';
import type { DashboardRepository, IndicatorsClient } from './repository.js';
import { toIndicators, type Indicators } from './representation.js';

/** The caller, as the authentication middleware read it from the database. */
export type DashboardCaller = { id: number; role: string };

/** The roles that receive the recent activity (`READER_OVERVIEW`: everyone else gets the overview). */
const ACTIVITY_ROLES: ReadonlySet<string> = new Set(['ADMINISTRATOR', 'DEVELOPER']);

/** The dashboard service. */
export type DashboardService = {
  /** `GET /dashboard/indicators` for `caller`. */
  indicators(caller: DashboardCaller, applicationId: number): Promise<Indicators>;
  /**
   * The same figures as `indicators` (without the recent activity), read on `client`, the transaction of another
   * module's snapshot (the report's Summary, D-116). It runs the same statement and the same representation.
   *
   * @throws {ApiError} 404 when the application does not exist.
   */
  indicatorsOn(client: IndicatorsClient, applicationId: number): Promise<Indicators>;
};

/**
 * Creates the dashboard service.
 *
 * @param repository - Read-only queries of the module.
 * @param audit - The audit service; the recent activity is read through it, inside the dashboard's transaction.
 * @param jira - The Jira client; only its state is read.
 */
export function createDashboardService(
  repository: DashboardRepository,
  audit: Pick<AuditService, 'recentActivity'>,
  jira: Pick<JiraClient, 'jiraAvailable'>,
): DashboardService {
  return {
    async indicatorsOn(client, applicationId) {
      assertIdInRange(applicationId, 'application');
      const row = await repository.readIndicators(client, applicationId);
      if (row === null) throw E.notFound('application', applicationId);
      return toIndicators(row, jira.jiraAvailable);
    },

    async indicators(caller, applicationId) {
      assertIdInRange(applicationId, 'application');
      const read = await repository.inSnapshot(async (snapshot) => {
        const row = await snapshot.indicators(applicationId);
        if (row === null) return null;
        const activity = ACTIVITY_ROLES.has(caller.role)
          ? await audit.recentActivity(applicationId, snapshot.client)
          : undefined;
        return { row, activity };
      });
      if (read === null) throw E.notFound('application', applicationId);
      return toIndicators(read.row, jira.jiraAvailable, read.activity);
    },
  };
}
