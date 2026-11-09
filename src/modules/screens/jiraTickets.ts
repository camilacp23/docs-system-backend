/**
 * Creation of Jira tickets from a screen (FR-12; SDD Table 50 and Figure 24; D-06, D-15, D-31, D-45, D-90 to D-94).
 * The service never sees req/res. Hierarchy Epic (one per screen) -> Story -> Subtask, created in Jira one call at a
 * time; each issue is saved locally, in its own audited write, as soon as Jira confirms it, so a retry after a partial
 * failure never duplicates what exists.
 *
 * Errors, in order: 400 (summaries) -> 404 (screen) -> 422 APPLICATION_ARCHIVED -> 422 STORY_NOT_IN_SCREEN -> 502
 * JIRA_UNAVAILABLE (nothing was created) -> creation -> 502 JIRA_PARTIAL_FAILURE (something was created).
 *
 * No database transaction stays open during a call to Jira. The creation of the Epic is serialized per screen inside
 * the process (D-93): the local unique index would arrive too late, because the second Epic would already exist in
 * Jira.
 *
 * @module modules/screens/jiraTickets
 */
import type { Database } from '../../db/prisma.js';
import type { JiraHierarchyLevel } from '../../generated/prisma/client.js';
import { INT32_MAX } from '../../http/ids.js';
import type { Logger } from '../../http/logger.js';
import {
  JiraCircuitOpenError,
  JiraError,
  JiraProtocolError,
  JiraRequestError,
  JiraUnavailableError,
  keysJql,
  type JiraClient,
  type JiraIssue,
} from '../../integrations/jira/index.js';
import { ApiError, E, type FieldError } from '../../security/errors.js';
import type { ApplicationService } from '../applications/service.js';
import { createKeyedMutex } from './keyedMutex.js';
import * as jiraRepo from './jiraRepository.js';
import { createTicketView, type JiraTicketView } from './jiraView.js';
import * as repo from './repository.js';

/** Jira's limit for a summary. */
const SUMMARY_MAX = 255;

/** Issue type names stored until Jira reports the real ones (D-90). */
const PROVISIONAL_TYPE: Record<JiraHierarchyLevel, string> = { EPIC: 'Epic', STANDARD: 'Story', SUBTASK: 'Subtask' };

/** Text of a Story or Subtask in the body (contract schema `JiraIssueText`). */
export type IssueTextInput = { summary: string; description?: string | null | undefined };

/** Body of `POST /screens/{id}/jira-ticket` (contract schema `JiraTicketCreate`): `storyId` or `newStory`. */
export type JiraTicketInput = { storyId?: number | undefined; newStory?: IssueTextInput; subtask: IssueTextInput };

/** What `POST /screens/{id}/jira-ticket` answers (contract schema `JiraTicketCreatedEnvelope.data`). */
export type JiraTicketCreated = {
  epic: JiraTicketView;
  story: JiraTicketView;
  subtask: JiraTicketView;
  /** Levels created by this request, in creation order. */
  created: JiraHierarchyLevel[];
};

/** The Jira tickets service. */
export type JiraTicketService = {
  /**
   * Creates the Subtask (and the Epic and the Story when they are missing) of a screen.
   *
   * @param actorId - The caller: `created_by` of every ticket and the actor of the audit.
   * @param screenId - Screen the "future to do" item belongs to.
   * @param input - `storyId` of an existing Story, or `newStory`, plus the `subtask`.
   */
  create(actorId: number, screenId: number, input: JiraTicketInput): Promise<JiraTicketCreated>;
};

/** What the service needs from the outside. */
export type JiraTicketDeps = {
  db: Pick<Database, 'base' | 'auditedTransaction'>;
  applications: Pick<ApplicationService, 'get' | 'assertApplicationActive'>;
  jira: Pick<JiraClient, 'jiraAvailable' | 'createIssue' | 'searchIssues'>;
  /** Base URL of Jira (for the links); undefined when Jira is not configured. */
  jiraBaseUrl: string | undefined;
  logger: Pick<Logger, 'warn' | 'error'>;
  /** Project used when the application has no `jiraProjectKey` (D-91). */
  defaultProjectKey: string | undefined;
};

/** 400 for a summary: `required` for blank text, `maxLength` for more than 255 characters, `singleLine` for line breaks. */
function summaryErrors(field: string, summary: string): FieldError[] {
  if (summary.trim() === '') return [{ field, rule: 'required', message: 'This value is required.' }];
  if (summary.length > SUMMARY_MAX) {
    return [{ field, rule: 'maxLength', message: `must NOT have more than ${SUMMARY_MAX} characters` }];
  }
  if (/[\r\n]/.test(summary)) return [{ field, rule: 'singleLine', message: 'Summary must be a single line.' }];
  return [];
}

/** An issue Jira created that could not be saved here (D-94). It stops the creation: the next issue needs its parent. */
class UnsavedIssue extends Error {
  constructor(
    readonly key: string,
    readonly level: JiraHierarchyLevel,
    readonly reason: 'SCREEN_DELETED' | 'SAVE_FAILED',
    /** Class and code of the error that stopped the write: never its message, which carries the query values. */
    readonly cause?: { errorClass: string; code: string | null },
  ) {
    super(`Jira issue not saved (${reason})`);
  }
}

/**
 * Summary of the screen's Epic: `<screen> (<application>)` (D-91). Over 255 characters, the screen name is cut and
 * ends in "…"; the application stays complete.
 *
 * @param screenName - Name of the screen (line breaks become spaces: a summary is one line).
 * @param applicationName - Name of the application.
 */
export function epicSummary(screenName: string, applicationName: string): string {
  const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
  const suffix = ` (${oneLine(applicationName)})`;
  const name = oneLine(screenName);
  if (name.length + suffix.length <= SUMMARY_MAX) return `${name}${suffix}`;
  let cut = Math.max(SUMMARY_MAX - suffix.length - 1, 0);
  const last = name.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1; // never split a surrogate pair
  return `${name.slice(0, cut).trimEnd()}…${suffix}`;
}

/** Whether Jira may have created the issue although the call failed (a timeout, a network error, a 5xx, an unreadable answer). */
function outcomeUnknown(error: JiraError): boolean {
  if (error instanceof JiraProtocolError) return true;
  return (
    error instanceof JiraUnavailableError &&
    ['NETWORK', 'TIMEOUT', 'SERVER_ERROR', 'BAD_RESPONSE'].includes(error.reason)
  );
}

/**
 * Creates the Jira tickets service.
 *
 * @param deps - Database, applications service, Jira client, link base, logger and default project.
 */
export function createJiraTicketService(deps: JiraTicketDeps): JiraTicketService {
  const { db, applications, jira, logger } = deps;
  const epicMutex = createKeyedMutex<number>();
  const view = createTicketView(deps.jiraBaseUrl);

  return {
    async create(actorId, screenId, input) {
      // 400: what the contract validator cannot say (blank, line breaks, code points over 255).
      const fields = [
        ...(input.newStory === undefined ? [] : summaryErrors('newStory.summary', input.newStory.summary)),
        ...summaryErrors('subtask.summary', input.subtask.summary),
      ];
      if (fields.length > 0) throw E.validation(fields);

      // 404, 422 APPLICATION_ARCHIVED, 422 STORY_NOT_IN_SCREEN (D-92).
      const screen = screenId > INT32_MAX ? null : await repo.findScreenRef(db.base, screenId);
      if (screen === null) throw E.notFound('screen', screenId);
      const application = await applications.get(screen.applicationId);
      await applications.assertApplicationActive(db.base, application.id);
      let story: jiraRepo.TicketRow | null = null;
      if (input.storyId !== undefined) {
        story = input.storyId > INT32_MAX ? null : await jiraRepo.findStory(db.base, screen.id, input.storyId);
        if (story === null) throw E.storyNotInScreen(input.storyId);
      }

      // 502 JIRA_UNAVAILABLE before creating anything: not configured or circuit open.
      if (!jira.jiraAvailable) throw E.jiraUnavailable();

      const projectKey = application.jiraProjectKey ?? deps.defaultProjectKey;
      const reference = { screenId: screen.id, screenName: screen.name, applicationName: application.name };
      /** What this request created in Jira, in order. */
      const made: { level: JiraHierarchyLevel; key: string; row: jiraRepo.TicketRow }[] = [];

      /** The creation in progress: what a failure reports (D-94). */
      let attempting: { level: JiraHierarchyLevel; parentKey: string | null } | null = null;

      /** Creates one issue in Jira and saves it at once (D-31). */
      const createAndStore = async (
        level: JiraHierarchyLevel,
        text: IssueTextInput,
        parent: jiraRepo.TicketRow | null,
      ): Promise<jiraRepo.TicketRow> => {
        attempting = { level, parentKey: parent?.jiraIssueKey ?? null };
        const issue = await jira.createIssue({
          level,
          summary: text.summary,
          description: text.description ?? undefined,
          screen: reference,
          projectKey,
          parentKey: parent?.jiraIssueKey,
        });
        let row: jiraRepo.TicketRow;
        try {
          row = await db.auditedTransaction(async (tx) => {
            // The lock makes a concurrent deletion of the screen wait for this write, or lets us see that it happened.
            if (!(await jiraRepo.lockScreenShared(tx, screen.id)))
              throw new UnsavedIssue(issue.key, level, 'SCREEN_DELETED');
            await warnIfArchived(tx, screen.id, application.id, issue.key);
            return jiraRepo.createTicket(tx, {
              screenId: screen.id,
              createdById: actorId,
              jiraIssueId: issue.id,
              jiraIssueKey: issue.key,
              hierarchyLevel: level,
              issueType: PROVISIONAL_TYPE[level],
              summary: text.summary,
              parent: parent === null ? null : { id: parent.id, level: parent.hierarchyLevel as 'EPIC' | 'STANDARD' },
            });
          });
        } catch (error) {
          if (error instanceof UnsavedIssue) throw error;
          const code = (error as { code?: unknown } | null)?.code;
          throw new UnsavedIssue(issue.key, level, 'SAVE_FAILED', {
            errorClass: error instanceof Error ? error.constructor.name : typeof error,
            code: typeof code === 'string' ? code : null,
          });
        }
        made.push({ level, key: issue.key, row });
        return row;
      };

      try {
        // The Epic, created lazily and only once per screen (D-15, D-93).
        const epic = await epicMutex.run(screen.id, async () => {
          const existing = await jiraRepo.findEpic(db.base, screen.id);
          if (existing !== null) return existing;
          return createAndStore('EPIC', { summary: epicSummary(screen.name, application.name) }, null);
        });
        story ??= await createAndStore('STANDARD', input.newStory!, epic);
        const subtask = await createAndStore('SUBTASK', input.subtask, story);

        const rows = await syncCreated([epic, story, subtask].filter((r) => made.some((m) => m.row.id === r.id)));
        const final = (row: jiraRepo.TicketRow): jiraRepo.TicketRow => rows.get(row.id) ?? row;
        return {
          epic: view(final(epic)),
          story: view(final(story)),
          subtask: view(final(subtask)),
          created: made.map((m) => m.level),
        };
      } catch (error) {
        throw failure(error, screen.id, application.id, attempting, made);
      }
    },
  };

  /**
   * D-90: one search by key (a single attempt, D-94) and one audited write with the state Jira reports. Any failure
   * leaves the provisional values, which a later read or the webhook corrects; it never fails the request.
   */
  async function syncCreated(rows: jiraRepo.TicketRow[]): Promise<Map<number, jiraRepo.TicketRow>> {
    const synced = new Map<number, jiraRepo.TicketRow>();
    if (rows.length === 0) return synced;
    try {
      const page = await jira.searchIssues({
        jql: keysJql(rows.map((r) => r.jiraIssueKey)),
        maxResults: rows.length,
        singleAttempt: true,
      });
      const byKey = new Map<string, JiraIssue>(page.issues.map((i) => [i.key, i]));
      const syncedAt = new Date();
      await db.auditedTransaction(async (tx) => {
        for (const row of rows) {
          const issue = byKey.get(row.jiraIssueKey);
          if (issue === undefined) continue;
          const state = {
            issueType: issue.issueType,
            summary: issue.summary,
            status: issue.status,
            statusCategory: issue.statusCategory,
          };
          if (await jiraRepo.updateSyncedState(tx, row.id, state, syncedAt)) {
            synced.set(row.id, { ...row, ...state, lastSyncedAt: syncedAt });
          }
        }
      });
    } catch (error) {
      synced.clear();
      logger.warn(
        { operation: 'syncCreatedIssues', reason: error instanceof JiraError ? error.reason : 'LOCAL_WRITE_FAILED' },
        'the final Jira search failed; the created tickets keep their provisional state',
      );
    }
    return synced;
  }

  /**
   * D-94: the application was archived after the request started. The issue already exists in Jira, so it is saved
   * anyway (the request is ordered before the archiving) and the event is logged.
   */
  async function warnIfArchived(
    tx: Parameters<typeof applications.assertApplicationActive>[0],
    screenId: number,
    applicationId: number,
    key: string,
  ): Promise<void> {
    try {
      await applications.assertApplicationActive(tx, applicationId);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'APPLICATION_ARCHIVED') throw error;
      logger.warn(
        { operation: 'createJiraTicket', screenId, applicationId, key },
        'the application was archived while the tickets were being created; the issue was saved anyway',
      );
    }
  }

  /** The answer for issues Jira created and this system could not save (D-94); the log names every key. */
  function unsavedFailure(
    error: UnsavedIssue,
    screenId: number,
    applicationId: number,
    made: { level: JiraHierarchyLevel; key: string }[],
  ): ApiError {
    const all = [...made, { level: error.level, key: error.key }];
    // A deleted screen takes its saved tickets with it (cascade): all of this request's issues are gone locally.
    const unsaved = (error.reason === 'SCREEN_DELETED' ? all : all.slice(-1)).map((m) => m.key);
    const names: Record<JiraHierarchyLevel, string> = { EPIC: 'epic', STANDARD: 'story', SUBTASK: 'subtask' };
    const created = Object.fromEntries(all.map((m) => [names[m.level], m.key]));
    logger.error(
      {
        operation: 'createJiraTicket',
        screenId,
        applicationId,
        reason: error.reason,
        ...error.cause,
        unsaved,
        createdKeys: all.map((m) => m.key),
      },
      'Jira created issues that could not be saved',
    );
    return E.jiraIssuesNotSaved(unsaved, created, error.reason);
  }

  /** The error to answer for a failure during the creation, logged without secrets (D-92, D-94). */
  function failure(
    error: unknown,
    screenId: number,
    applicationId: number,
    attempting: { level: JiraHierarchyLevel; parentKey: string | null } | null,
    made: { level: JiraHierarchyLevel; key: string; row: jiraRepo.TicketRow }[],
  ): unknown {
    if (error instanceof UnsavedIssue) return unsavedFailure(error, screenId, applicationId, made);
    if (!(error instanceof JiraError)) return error;
    const unknown = outcomeUnknown(error);
    const context = {
      operation: 'createJiraTicket',
      screenId,
      applicationId,
      reason: error.reason,
      ...(error instanceof JiraRequestError
        ? { status: error.status, jiraMessages: error.jiraMessages.slice(0, 5) }
        : {}),
      // A creation that timed out may exist in Jira although it was not saved: it is never retried (D-94).
      outcome: unknown ? 'unknown' : 'not_created',
      issueLevel: attempting?.level ?? null,
      parentKey: attempting?.parentKey ?? null,
      createdKeys: made.map((m) => m.key),
    };
    const quiet = error.availability || error.reason === 'NOT_CONFIGURED' || error instanceof JiraCircuitOpenError;
    if (quiet && !unknown) logger.warn(context, 'Jira did not create the issue');
    else logger.error(context, 'Jira did not create the issue');

    const story = made.find((m) => m.level === 'STANDARD');
    const epic = made.find((m) => m.level === 'EPIC');
    if (story !== undefined) {
      const created = { ...(epic === undefined ? {} : { epic: epic.key }), story: story.key };
      return E.jiraPartialFailure(story.key, created, story.row.id);
    }
    if (epic !== undefined) return E.jiraPartialEpicOnly(epic.key, { epic: epic.key });
    return E.jiraUnavailable();
  }
}
