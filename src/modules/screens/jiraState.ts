/**
 * Pure rules shared by the two ways a local Jira ticket is brought up to date: the refresh of
 * `GET /screens/{id}/jira-tickets` and the webhook (D-95, D-96, D-97). No database access here.
 *
 * @module modules/screens/jiraState
 */
import type { JiraHierarchyLevel, JiraStatusCategory } from '../../generated/prisma/client.js';

/** Column limits of `jira_ticket` (SDD Table 23). */
const LIMITS = { summary: 255, status: 100, issueType: 50 } as const;

/** Format enforced by `jira_ticket_key_format_chk`. */
const KEY_FORMAT = /^[A-Z][A-Z0-9_]+-[0-9]+$/;

/** The columns of a ticket that Jira owns (D-97). */
export type TrackedColumns = {
  jiraIssueKey: string;
  issueType: string;
  summary: string;
  status: string;
  statusCategory: JiraStatusCategory;
};

/** What Jira reports about an issue; every field is optional because a webhook carries only what Jira sent. */
export type IncomingState = Partial<{
  key: string;
  issueType: string;
  summary: string;
  status: string;
  statusCategory: JiraStatusCategory;
}>;

/** Why a reported value was not copied. Never carries the value itself (it may be a Jira key or text). */
export type SkipReason = 'KEY_INVALID' | 'VALUE_TOO_LONG';

/**
 * Compares what Jira reports with the stored row and returns only the columns that differ (D-97): an empty
 * `changes` means nothing is written.
 *
 * @param stored - The local row.
 * @param incoming - What Jira reported.
 * @returns The changed columns, and the fields that were left out because they cannot be stored.
 */
export function changedColumns(
  stored: TrackedColumns,
  incoming: IncomingState,
): { changes: Partial<TrackedColumns>; skipped: SkipReason[] } {
  const changes: Partial<TrackedColumns> = {};
  const skipped: SkipReason[] = [];
  const text = (column: 'summary' | 'status' | 'issueType', value: string | undefined): void => {
    if (value === undefined || value === stored[column]) return;
    if (value === '' || value.length > LIMITS[column]) skipped.push('VALUE_TOO_LONG');
    else changes[column] = value;
  };
  text('summary', incoming.summary);
  text('status', incoming.status);
  text('issueType', incoming.issueType);
  if (incoming.statusCategory !== undefined && incoming.statusCategory !== stored.statusCategory) {
    changes.statusCategory = incoming.statusCategory;
  }
  if (incoming.key !== undefined && incoming.key !== stored.jiraIssueKey) {
    if (KEY_FORMAT.test(incoming.key) && incoming.key.length <= 32) changes.jiraIssueKey = incoming.key;
    else skipped.push('KEY_INVALID');
  }
  return { changes, skipped };
}

/** The level a parent must have for a child of the given level (Story → Epic, Subtask → Story); null for an Epic. */
export function expectedParentLevel(level: JiraHierarchyLevel): JiraHierarchyLevel | null {
  if (level === 'STANDARD') return 'EPIC';
  if (level === 'SUBTASK') return 'STANDARD';
  return null;
}
