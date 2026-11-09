/**
 * `GET /screens/{id}/jira-tickets` (FR-12; SDD Table 50; D-95, D-97): the Jira tickets of a screen as a tree, from
 * the local copy. With `refresh=true` the copy is first brought up to date from Jira (JQL by keys, paginated); if
 * that cannot be completed the local copy is returned with `sync.stale = true`, never a 502 (NFR-14).
 *
 * The refresh is a read for the caller, so its writes are attributed to the reserved account, and only rows whose
 * tracked columns changed are written (D-97). It never deletes a row (only the webhook does).
 *
 * @module modules/screens/jiraTree
 */
import type { Database } from '../../db/prisma.js';
import { INT32_MAX } from '../../http/ids.js';
import type { Logger } from '../../http/logger.js';
import {
  JiraConfigurationError,
  JiraError,
  JiraProtocolError,
  keysJql,
  type JiraClient,
  type JiraIssue,
} from '../../integrations/jira/index.js';
import { ApiError, E } from '../../security/errors.js';
import type { ApplicationService } from '../applications/service.js';
import type { RunAsIntegration } from './jiraActor.js';
import * as jiraRepo from './jiraRepository.js';
import { changedColumns } from './jiraState.js';
import { createTicketView, type JiraTicketView } from './jiraView.js';
import * as repo from './repository.js';

/** Keys per JQL query. */
const KEY_BATCH = 100;
/** Issues per page of a search (Jira's maximum is 100). */
const DEFAULT_PAGE_SIZE = 100;

/** `sync` of the tree (contract schema `JiraTreeEnvelope`). */
export type JiraTreeSync = { jiraAvailable: boolean; stale: boolean; lastSyncedAt: Date | null };

/** The tree (contract schema `JiraTreeEnvelope.data`). */
export type JiraTree = {
  epic: JiraTicketView | null;
  stories: (JiraTicketView & { subtasks: JiraTicketView[] })[];
  sync: JiraTreeSync;
};

/** The Jira tree service. */
export type JiraTreeService = {
  /**
   * @param screenId - Screen to read.
   * @param options - `refresh`: also query Jira.
   * @throws {ApiError} 404 when the screen does not exist.
   */
  tree(screenId: number, options: { refresh: boolean }): Promise<JiraTree>;
};

/** What the service needs from the outside. */
export type JiraTreeDeps = {
  db: Pick<Database, 'base' | 'auditedTransaction'>;
  applications: Pick<ApplicationService, 'assertApplicationActive'>;
  jira: Pick<JiraClient, 'jiraAvailable' | 'searchIssues'>;
  jiraBaseUrl: string | undefined;
  logger: Pick<Logger, 'warn' | 'error'>;
  runAsIntegration: RunAsIntegration;
  /** Issues per page of the search (tests use a small one to exercise the pagination). */
  pageSize?: number;
};

/**
 * Creates the Jira tree service.
 *
 * @param deps - Database, Jira client, link base, logger and the reserved-account runner.
 */
export function createJiraTreeService(deps: JiraTreeDeps): JiraTreeService {
  const { db, applications, jira, logger } = deps;
  const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;
  const view = createTicketView(deps.jiraBaseUrl);

  /** Every issue of the keys, matched later by its stable id. Throws JiraError. */
  async function search(keys: string[]): Promise<{ issues: Map<string, JiraIssue>; skipped: number }> {
    const issues = new Map<string, JiraIssue>();
    let skipped = 0;
    for (let i = 0; i < keys.length; i += KEY_BATCH) {
      const jql = keysJql(keys.slice(i, i + KEY_BATCH));
      const seen = new Set<string>();
      let token: string | null = null;
      do {
        const page: Awaited<ReturnType<JiraClient['searchIssues']>> = await jira.searchIssues({
          jql,
          maxResults: pageSize,
          ...(token === null ? {} : { nextPageToken: token }),
        });
        for (const issue of page.issues) issues.set(issue.id, issue);
        skipped += page.skipped.length;
        token = page.nextPageToken;
        if (token !== null && seen.has(token)) throw new JiraProtocolError('page token');
        if (token !== null) seen.add(token);
      } while (token !== null);
    }
    return { issues, skipped };
  }

  /** Writes what changed (D-97) as the reserved account. False when the application was archived meanwhile. */
  async function apply(
    rows: jiraRepo.SyncRow[],
    applicationId: number,
    issues: Map<string, JiraIssue>,
    readAt: Date,
  ): Promise<boolean> {
    return deps.runAsIntegration(() =>
      db.auditedTransaction(async (tx) => {
        try {
          await applications.assertApplicationActive(tx, applicationId);
        } catch (error) {
          if (error instanceof ApiError && error.code === 'APPLICATION_ARCHIVED') return false;
          throw error;
        }
        // Fresh rows, locked: a webhook may have written since the first read.
        const locked = await jiraRepo.lockTickets(
          tx,
          rows.map((r) => r.id),
        );
        for (const row of await jiraRepo.findTicketsByIds(tx, locked)) {
          const issue = issues.get(row.jiraIssueId);
          // A row newer than this read (a webhook got there first) is never overwritten with older data.
          if (issue === undefined || row.lastSyncedAt.getTime() > readAt.getTime()) continue;
          let key: string | undefined = issue.key;
          if (key !== row.jiraIssueKey && (await jiraRepo.keyTakenByOther(tx, key, row.id))) {
            logger.warn(
              { operation: 'refreshJiraTickets', ticketId: row.id, reason: 'KEY_CONFLICT' },
              'key not updated',
            );
            key = undefined;
          }
          const { changes, skipped } = changedColumns(row, {
            ...(key === undefined ? {} : { key }),
            issueType: issue.issueType,
            summary: issue.summary,
            status: issue.status,
            statusCategory: issue.statusCategory,
          });
          for (const reason of skipped) {
            logger.warn({ operation: 'refreshJiraTickets', ticketId: row.id, reason }, 'value not stored');
          }
          if (Object.keys(changes).length > 0) await jiraRepo.writeSync(tx, row.id, changes, readAt);
        }
        return true;
      }),
    );
  }

  /** Tries to bring the local copy up to date. True only when it was completed. */
  async function refresh(rows: jiraRepo.SyncRow[], applicationId: number, readAt: Date): Promise<boolean> {
    if (!jira.jiraAvailable) return false;
    try {
      await applications.assertApplicationActive(db.base, applicationId);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'APPLICATION_ARCHIVED') return false;
      throw error;
    }
    if (rows.length === 0) return true;
    try {
      const { issues, skipped } = await search(rows.map((r) => r.jiraIssueKey));
      if (skipped > 0)
        logger.warn({ operation: 'refreshJiraTickets', skipped }, 'issues with unmodelled data left out');
      return await apply(rows, applicationId, issues, readAt);
    } catch (error) {
      if (!(error instanceof JiraError)) throw error;
      const context = { operation: 'refreshJiraTickets', reason: error.reason };
      const quiet = error.availability || error.reason === 'NOT_CONFIGURED' || error.reason === 'CIRCUIT_OPEN';
      if (quiet && !(error instanceof JiraConfigurationError)) logger.warn(context, 'Jira refresh not completed');
      else logger.error(context, 'Jira refresh not completed');
      return false;
    }
  }

  return {
    async tree(screenId, options) {
      const screen = screenId > INT32_MAX ? null : await repo.findScreenRef(db.base, screenId);
      if (screen === null) throw E.notFound('screen', screenId);

      // The instant BEFORE the first page (D-95): an event after it is newer than what the search can have read.
      const readAt = new Date();
      const before = await jiraRepo.listTickets(db.base, screen.id);
      const completed = options.refresh ? await refresh(before, screen.applicationId, readAt) : false;
      const rows = options.refresh && completed ? await jiraRepo.listTickets(db.base, screen.id) : before;

      const subtasks = new Map<number, JiraTicketView[]>();
      for (const row of rows) {
        if (row.hierarchyLevel === 'SUBTASK' && row.parentTicketId !== null) {
          subtasks.set(row.parentTicketId, [...(subtasks.get(row.parentTicketId) ?? []), view(row)]);
        }
      }
      const epic = rows.find((r) => r.hierarchyLevel === 'EPIC');
      const newest = rows.reduce<Date | null>(
        (max, r) => (max === null || r.lastSyncedAt.getTime() > max.getTime() ? r.lastSyncedAt : max),
        null,
      );
      return {
        epic: epic === undefined ? null : view(epic),
        stories: rows
          .filter((r) => r.hierarchyLevel === 'STANDARD')
          .map((r) => ({ ...view(r), subtasks: subtasks.get(r.id) ?? [] })),
        sync: {
          jiraAvailable: jira.jiraAvailable,
          stale: options.refresh && !completed,
          lastSyncedAt: options.refresh && completed ? readAt : newest,
        },
      };
    },
  };
}
