/**
 * Processing of a Jira Cloud webhook delivery (FR-12; SDD 7.2.8, Table 53, Figure 25; D-31, D-96, D-97). The
 * signature was already verified on the raw body by the gate mounted before any parser (`http/jiraWebhookGate`);
 * this service receives those verified bytes. It never sees req/res.
 *
 * Steps: 400 (parse and validate) -> `jira:issue_created` ignored -> ticket not tracked -> application archived ->
 * event older than the local copy -> apply (updated) or delete (deleted). Everything after the validation runs in ONE
 * transaction with the row locked `FOR UPDATE`, so two simultaneous or out-of-order deliveries cannot overwrite each
 * other, and as the reserved account, so the audit shows that Jira made the change. Nothing is written when no
 * tracked column changes (D-97). No log contains the body, the signature, the secret or a header.
 *
 * @module modules/screens/jiraWebhook
 */
import type { Database } from '../../db/prisma.js';
import type { Logger } from '../../http/logger.js';
import { mapHierarchyLevel, mapStatusCategory } from '../../integrations/jira/mapping.js';
import type { JiraHierarchyLevel } from '../../integrations/jira/types.js';
import { ApiError, E, type FieldError } from '../../security/errors.js';
import type { ApplicationService } from '../applications/service.js';
import type { RunAsIntegration } from './jiraActor.js';
import * as jiraRepo from './jiraRepository.js';
import { changedColumns, expectedParentLevel, type IncomingState } from './jiraState.js';
import * as repo from './repository.js';

/** What happened to a delivery (also the `outcome` of its log line). */
export type WebhookOutcome =
  | 'applied'
  | 'deleted'
  | 'ignored_created'
  | 'ignored_untracked'
  | 'ignored_archived'
  | 'ignored_stale'
  | 'ignored_unchanged';

/** The Jira webhook service. */
export type JiraWebhookService = {
  /**
   * @param rawBody - The verified raw body.
   * @param deliveryId - `X-Atlassian-Webhook-Identifier` when it is safe to log; only for tracing.
   * @throws {ApiError} 400 VALIDATION_ERROR when the body is not a usable event.
   */
  receive(rawBody: Buffer, deliveryId?: string): Promise<WebhookOutcome>;
};

/** What the service needs from the outside. */
export type JiraWebhookDeps = {
  db: Pick<Database, 'base' | 'auditedTransaction'>;
  applications: Pick<ApplicationService, 'assertApplicationActive'>;
  logger: Pick<Logger, 'info' | 'warn'>;
  runAsIntegration: RunAsIntegration;
  /** Clock for an event without `timestamp` (tests may fix it). */
  now?: () => number;
};

type ParsedEvent = {
  event: 'updated' | 'deleted' | 'created';
  /** Milliseconds; undefined when the delivery has none. */
  timestamp: number | undefined;
  issueId: string;
  key: string | undefined;
  summary: string | undefined;
  statusName: string | undefined;
  categoryKey: string | undefined;
  level: unknown;
  hasFields: boolean;
  /** undefined = absent; null = present without an id. */
  parentId: string | null | undefined;
};

const EVENTS = {
  'jira:issue_updated': 'updated',
  'jira:issue_deleted': 'deleted',
  'jira:issue_created': 'created',
} as const;
/** Length of `jira_ticket.jira_issue_id`. */
const ISSUE_ID_MAX = 32;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Step 2: parses the body and validates the fields the server uses; anything else is tolerated. */
function parse(rawBody: Buffer): ParsedEvent {
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    body = undefined;
  }
  if (!isObj(body)) throw E.validation([{ field: 'body', rule: 'type', message: 'must be a JSON object' }]);

  const errors: FieldError[] = [];
  const name = body['webhookEvent'];
  if (name === undefined) {
    errors.push({ field: 'webhookEvent', rule: 'required', message: "must have required property 'webhookEvent'" });
  } else if (typeof name !== 'string' || !Object.hasOwn(EVENTS, name)) {
    errors.push({ field: 'webhookEvent', rule: 'enum', message: 'must be equal to one of the allowed values' });
  }
  const ts = body['timestamp'];
  if (ts !== undefined && (typeof ts !== 'number' || !Number.isSafeInteger(ts) || ts < 0)) {
    errors.push({ field: 'timestamp', rule: 'type', message: 'must be integer' });
  }
  const issue = isObj(body['issue']) ? body['issue'] : undefined;
  if (issue === undefined) {
    errors.push({ field: 'issue', rule: 'required', message: "must have required property 'issue'" });
  } else {
    const id = issue['id'];
    if (id === undefined) {
      errors.push({ field: 'issue.id', rule: 'required', message: "must have required property 'id'" });
    } else if (typeof id !== 'string' || id === '' || id.length > ISSUE_ID_MAX) {
      errors.push({ field: 'issue.id', rule: 'type', message: 'must be a string of 1 to 32 characters' });
    }
  }
  if (errors.length > 0 || issue === undefined) throw E.validation(errors);

  const fields = isObj(issue['fields']) ? issue['fields'] : undefined;
  const status = fields !== undefined && isObj(fields['status']) ? fields['status'] : undefined;
  const category = status !== undefined && isObj(status['statusCategory']) ? status['statusCategory'] : undefined;
  const type = fields !== undefined && isObj(fields['issuetype']) ? fields['issuetype'] : undefined;
  const parent = fields === undefined ? undefined : fields['parent'];
  return {
    event: EVENTS[name as keyof typeof EVENTS],
    timestamp: typeof ts === 'number' ? ts : undefined,
    issueId: issue['id'] as string,
    key: str(issue['key']),
    summary: fields === undefined ? undefined : str(fields['summary']),
    statusName: status === undefined ? undefined : str(status['name']),
    categoryKey: category === undefined ? undefined : str(category['key']),
    level: type?.['hierarchyLevel'],
    hasFields: fields !== undefined,
    parentId: isObj(parent) ? (str(parent['id']) ?? null) : parent === undefined ? undefined : null,
  };
}

/**
 * Creates the Jira webhook service.
 *
 * @param deps - Database, applications service, logger and the reserved-account runner.
 */
export function createJiraWebhookService(deps: JiraWebhookDeps): JiraWebhookService {
  const { db, applications, logger } = deps;
  const now = deps.now ?? Date.now;
  const OP = 'receiveJiraWebhook';

  /** Step 5, parent and level (D-96): the new parent when it fits the local hierarchy, otherwise nothing (with a warn). */
  async function newParent(
    tx: Parameters<typeof jiraRepo.findTicketByIssueId>[0],
    row: jiraRepo.SyncRow,
    e: ParsedEvent,
  ): Promise<jiraRepo.SyncChanges> {
    const keep = (reason: string): jiraRepo.SyncChanges => {
      logger.warn({ operation: OP, screenId: row.screenId, ticketId: row.id, reason }, 'hierarchy change not applied');
      return {};
    };
    if (e.level !== undefined) {
      let level: JiraHierarchyLevel;
      try {
        level = mapHierarchyLevel(e.level);
      } catch {
        return keep('LEVEL_UNKNOWN');
      }
      if (level !== row.hierarchyLevel) return keep('LEVEL_CHANGED');
    }
    const expected = expectedParentLevel(row.hierarchyLevel);
    if (expected === null) return e.parentId === undefined || e.parentId === null ? {} : keep('PARENT_NOT_FITTING');
    if (!e.hasFields) return {};
    if (e.parentId === undefined || e.parentId === null) return keep('PARENT_MISSING');
    const candidate = await jiraRepo.findTicketByIssueId(tx, row.screenId, e.parentId);
    if (candidate === null || candidate.hierarchyLevel !== expected) return keep('PARENT_NOT_FITTING');
    if (candidate.id === row.parentTicketId) return {};
    return { parentTicketId: candidate.id, parentLevel: candidate.hierarchyLevel };
  }

  return {
    async receive(rawBody, deliveryId) {
      const e = parse(rawBody);
      const done = (outcome: WebhookOutcome, ticketId?: number): WebhookOutcome => {
        logger.info(
          {
            operation: OP,
            outcome,
            ...(ticketId === undefined ? {} : { ticketId }),
            ...(deliveryId === undefined ? {} : { deliveryId }),
          },
          'jira webhook processed',
        );
        return outcome;
      };
      if (e.event === 'created') return done('ignored_created');
      const at = e.timestamp ?? now();

      const result = await deps.runAsIntegration(() =>
        db.auditedTransaction(async (tx): Promise<{ outcome: WebhookOutcome; ticketId?: number }> => {
          // Step 3: the row is locked from here on, so the comparison of step 4 and the write cannot interleave.
          const row = await jiraRepo.lockTicketByIssueId(tx, e.issueId);
          if (row === null) return { outcome: 'ignored_untracked' };
          const screen = await repo.findScreenRef(tx, row.screenId);
          if (screen === null) return { outcome: 'ignored_untracked' };
          try {
            await applications.assertApplicationActive(tx, screen.applicationId);
          } catch (error) {
            if (error instanceof ApiError && error.code === 'APPLICATION_ARCHIVED') {
              return { outcome: 'ignored_archived', ticketId: row.id };
            }
            throw error;
          }
          // Step 4: only an EARLIER event is ignored; an equal timestamp is applied (D-96).
          if (at < row.lastSyncedAt.getTime()) return { outcome: 'ignored_stale', ticketId: row.id };

          if (e.event === 'deleted') {
            await jiraRepo.deleteTicket(tx, row.id);
            return { outcome: 'deleted', ticketId: row.id };
          }

          const incoming: IncomingState = {};
          if (e.summary !== undefined) incoming.summary = e.summary;
          if (e.statusName !== undefined) incoming.status = e.statusName;
          if (e.categoryKey !== undefined) {
            try {
              incoming.statusCategory = mapStatusCategory(e.categoryKey);
            } catch {
              logger.warn(
                { operation: OP, ticketId: row.id, reason: 'CATEGORY_UNKNOWN' },
                'status category not copied',
              );
            }
          }
          if (e.key !== undefined) {
            if (e.key !== row.jiraIssueKey && (await jiraRepo.keyTakenByOther(tx, e.key, row.id))) {
              logger.warn({ operation: OP, ticketId: row.id, reason: 'KEY_CONFLICT' }, 'key not updated');
            } else {
              incoming.key = e.key;
            }
          }
          const { changes, skipped } = changedColumns(row, incoming);
          for (const reason of skipped) logger.warn({ operation: OP, ticketId: row.id, reason }, 'value not stored');
          const all: jiraRepo.SyncChanges = { ...changes, ...(await newParent(tx, row, e)) };
          if (Object.keys(all).length === 0) return { outcome: 'ignored_unchanged', ticketId: row.id };
          await jiraRepo.writeSync(tx, row.id, all, new Date(at));
          return { outcome: 'applied', ticketId: row.id };
        }),
      );
      return done(result.outcome, result.ticketId);
    },
  };
}
