/**
 * Prisma queries of the Jira tickets of a screen (FR-12, SDD Table 23). No rules live here (SDD Table 6, D-42).
 *
 * @module modules/screens/jiraRepository
 */
import type { JiraHierarchyLevel, JiraStatusCategory, PrismaClient } from '../../generated/prisma/client.js';

/** Clients accepted by the queries: the plain client or the transaction client of `auditedTransaction`. */
export type JiraTicketsClient = Pick<PrismaClient, 'jiraTicket' | '$queryRaw'>;

/** A stored ticket, with the columns the API returns (contract schema `JiraTicket`). */
export type TicketRow = {
  id: number;
  jiraIssueKey: string;
  hierarchyLevel: JiraHierarchyLevel;
  issueType: string;
  summary: string;
  status: string;
  statusCategory: JiraStatusCategory;
  lastSyncedAt: Date;
};

const SELECT = {
  id: true,
  jiraIssueKey: true,
  hierarchyLevel: true,
  issueType: true,
  summary: true,
  status: true,
  statusCategory: true,
  lastSyncedAt: true,
} as const;

/** Locks the screen against deletion until the end of the transaction; `false` when it no longer exists. */
export async function lockScreenShared(client: Pick<JiraTicketsClient, '$queryRaw'>, id: number): Promise<boolean> {
  const rows = await client.$queryRaw<{ id: number }[]>`SELECT id FROM screen WHERE id = ${id} FOR SHARE`;
  return rows.length > 0;
}

/** The Epic of a screen, or null (there is at most one: `jira_ticket_one_epic_per_screen`). */
export function findEpic(client: Pick<JiraTicketsClient, 'jiraTicket'>, screenId: number): Promise<TicketRow | null> {
  return client.jiraTicket.findFirst({ where: { screenId, hierarchyLevel: 'EPIC' }, select: SELECT });
}

/** A Story of the screen by local id, or null when the id belongs to another screen or to another level. */
export function findStory(
  client: Pick<JiraTicketsClient, 'jiraTicket'>,
  screenId: number,
  id: number,
): Promise<TicketRow | null> {
  return client.jiraTicket.findFirst({ where: { id, screenId, hierarchyLevel: 'STANDARD' }, select: SELECT });
}

/** What is stored when Jira confirms an issue (D-90: the state is provisional until the final search). */
export type NewTicket = {
  screenId: number;
  createdById: number;
  jiraIssueId: string;
  jiraIssueKey: string;
  hierarchyLevel: JiraHierarchyLevel;
  issueType: string;
  summary: string;
  parent: { id: number; level: 'EPIC' | 'STANDARD' } | null;
};

/** Inserts a ticket with the provisional state "To Do" / TO_DO (D-90). */
export function createTicket(client: Pick<JiraTicketsClient, 'jiraTicket'>, data: NewTicket): Promise<TicketRow> {
  return client.jiraTicket.create({
    data: {
      screenId: data.screenId,
      createdById: data.createdById,
      jiraIssueId: data.jiraIssueId,
      jiraIssueKey: data.jiraIssueKey,
      hierarchyLevel: data.hierarchyLevel,
      issueType: data.issueType,
      parentTicketId: data.parent?.id ?? null,
      parentLevel: data.parent?.level ?? null,
      summary: data.summary,
      status: 'To Do',
      statusCategory: 'TO_DO',
    },
    select: SELECT,
  });
}

/** The state Jira reports (D-90). `hierarchy_level` is not here: it is part of the parent's foreign key. */
export type SyncedState = {
  issueType: string;
  summary: string;
  status: string;
  statusCategory: JiraStatusCategory;
};

/** Writes the state read from Jira; `false` when the row no longer exists (a webhook or a deletion got there first). */
export async function updateSyncedState(
  client: Pick<JiraTicketsClient, 'jiraTicket'>,
  id: number,
  state: SyncedState,
  syncedAt: Date,
): Promise<boolean> {
  const result = await client.jiraTicket.updateMany({ where: { id }, data: { ...state, lastSyncedAt: syncedAt } });
  return result.count > 0;
}
