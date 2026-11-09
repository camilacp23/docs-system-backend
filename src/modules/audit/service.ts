/**
 * Rules of the audit history (FR-20, FR-21; D-107). Read only. The service never sees req/res.
 *
 * Order of the answers: the role gate (x-roles) and the contract validator run before this code, so a Reader is 403
 * and a malformed request is 400 first. Here the rules that cross parameters come next (400), then
 * `DEVELOPER_OWN_ACTIONS` (403), and only then the query.
 *
 * @module modules/audit/service
 */
import { INT32_MAX } from '../../http/ids.js';
import { E } from '../../security/errors.js';
import type { AuditFilters, AuditReadClient, AuditRepository } from './repository.js';
import { toActivitySummary, toAuditEntry, type ActivitySummary, type AuditEntry } from './representation.js';

/** The caller, as the authentication middleware read it from the database. */
export type AuditCaller = { id: number; role: string };

/** The parameters of `GET /audit-log`, already parsed by the controller. */
export type AuditQuery = AuditFilters & { skip: number; take: number };

/** A page of entries and the number of records that match. */
export type AuditEntries = { data: AuditEntry[]; total: number };

/** The audit service. */
export type AuditService = {
  /** `GET /audit-log` for `caller`. */
  list(caller: AuditCaller, query: AuditQuery): Promise<AuditEntries>;
  /**
   * The 10 most recent records of an application, of the whole team, as summaries without values or database role
   * (D-106 e). For the dashboard; there is no HTTP route. Pass `client` to read inside the caller's transaction.
   */
  recentActivity(applicationId: number, client?: AuditReadClient): Promise<ActivitySummary[]>;
};

/** `Date.parse` of an ISO 8601 text; NaN when JavaScript cannot represent it. */
const instantOf = (text: string): number => Date.parse(text);

/**
 * The rules that cross parameters (D-107 a, c).
 *
 * `from` and `to` are compared in milliseconds, the precision of `created_at`. When JavaScript cannot read one of them
 * (`Date.parse` gives NaN, for example for the leap second `23:59:60Z`, which the validator's `date-time` format
 * accepts and PostgreSQL reads), the `range` rule is skipped and PostgreSQL compares the rows with exact instants.
 */
function assertConsistent(query: AuditQuery): void {
  if (query.entityId !== undefined && query.entityType === undefined) {
    throw E.validation([{ field: 'entityType', rule: 'required', message: 'This value is required.' }]);
  }
  if (query.from !== undefined && query.to !== undefined) {
    const from = instantOf(query.from);
    const to = instantOf(query.to);
    if (!Number.isNaN(from) && !Number.isNaN(to) && from > to) {
      throw E.validation([{ field: 'to', rule: 'range', message: "'to' must not be earlier than 'from'." }]);
    }
  }
}

/**
 * Creates the audit service.
 *
 * @param repository - Read-only queries of the module.
 */
export function createAuditService(repository: AuditRepository): AuditService {
  return {
    async list(caller, query) {
      assertConsistent(query);
      const { skip, take, ...filters } = query;
      const isDeveloper = caller.role === 'DEVELOPER';
      if (isDeveloper) {
        // DEVELOPER_OWN_ACTIONS: without actorUserId the caller's own; their own id is valid; anyone else is 403.
        if (filters.actorUserId !== undefined && filters.actorUserId !== caller.id) throw E.forbiddenOwnActions();
        filters.actorUserId = caller.id;
      }
      // An id beyond `integer` cannot exist (D-70): an empty page, without reaching PostgreSQL.
      if ((filters.applicationId ?? 0) > INT32_MAX || (filters.actorUserId ?? 0) > INT32_MAX) {
        return { data: [], total: 0 };
      }
      const page = await repository.readPage(filters, skip, take);
      return { data: page.rows.map((row) => toAuditEntry(row, caller.role === 'ADMINISTRATOR')), total: page.total };
    },

    async recentActivity(applicationId, client) {
      if (applicationId > INT32_MAX) return [];
      return (await repository.readRecent(applicationId, client)).map(toActivitySummary);
    },
  };
}
