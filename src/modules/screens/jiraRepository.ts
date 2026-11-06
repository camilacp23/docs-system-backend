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

// ------------------------------------------------------------------------------------- tree, refresh, webhook

/** A stored ticket with the columns the tree, the refresh and the webhook need (D-95, D-96). */
export type SyncRow = TicketRow & {
  screenId: number;
  jiraIssueId: string;
  parentTicketId: number | null;
  parentLevel: JiraHierarchyLevel | null;
};

const SYNC_SELECT = { ...SELECT, screenId: true, jiraIssueId: true, parentTicketId: true, parentLevel: true } as const;

/** Every ticket of a screen in creation order (`id` ascending, D-95), or none. */
export function listTickets(client: Pick<JiraTicketsClient, 'jiraTicket'>, screenId: number): Promise<SyncRow[]> {
  return client.jiraTicket.findMany({ where: { screenId }, orderBy: { id: 'asc' }, select: SYNC_SELECT });
}

/** The tickets with the given ids, locked until the end of the transaction, in a fixed order (no deadlocks). */
export async function lockTickets(client: Pick<JiraTicketsClient, '$queryRaw'>, ids: number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await client.$queryRaw<{ id: number }[]>`
    SELECT id FROM jira_ticket WHERE id = ANY(${ids}::int[]) ORDER BY id FOR UPDATE`;
  return rows.map((r) => r.id);
}

/** One ticket by the stable Jira id, locked `FOR UPDATE` until the end of the transaction (Table 53, step 3). */
export async function lockTicketByIssueId(
  client: Pick<JiraTicketsClient, '$queryRaw'>,
  jiraIssueId: string,
): Promise<SyncRow | null> {
  const rows = await client.$queryRaw<
    {
      id: number;
      screen_id: number;
      jira_issue_id: string;
      jira_issue_key: string;
      hierarchy_level: JiraHierarchyLevel;
      issue_type: string;
      summary: string;
      status: string;
      status_category: JiraStatusCategory;
      parent_ticket_id: number | null;
      parent_level: JiraHierarchyLevel | null;
      last_synced_at: Date;
    }[]
  >`
    SELECT id, screen_id, jira_issue_id, jira_issue_key, hierarchy_level, issue_type, summary, status,
           status_category, parent_ticket_id, parent_level, last_synced_at
      FROM jira_ticket WHERE jira_issue_id = ${jiraIssueId} FOR UPDATE`;
  const r = rows[0];
  if (r === undefined) return null;
  return {
    id: r.id,
    screenId: r.screen_id,
    jiraIssueId: r.jira_issue_id,
    jiraIssueKey: r.jira_issue_key,
    hierarchyLevel: r.hierarchy_level,
    issueType: r.issue_type,
    summary: r.summary,
    status: r.status,
    statusCategory: r.status_category,
    parentTicketId: r.parent_ticket_id,
    parentLevel: r.parent_level,
    lastSyncedAt: r.last_synced_at,
  };
}

/** Reads the given tickets (by id) as the transaction sees them. */
export function findTicketsByIds(client: Pick<JiraTicketsClient, 'jiraTicket'>, ids: number[]): Promise<SyncRow[]> {
  return client.jiraTicket.findMany({ where: { id: { in: ids } }, orderBy: { id: 'asc' }, select: SYNC_SELECT });
}

/** True when ANOTHER ticket already has the Jira key (the column is unique). */
export async function keyTakenByOther(
  client: Pick<JiraTicketsClient, 'jiraTicket'>,
  key: string,
  id: number,
): Promise<boolean> {
  return (await client.jiraTicket.count({ where: { jiraIssueKey: key, NOT: { id } } })) > 0;
}

/** A ticket of the screen by its stable Jira id: the candidate parent of an event (id and level only). */
export function findTicketByIssueId(
  client: Pick<JiraTicketsClient, 'jiraTicket'>,
  screenId: number,
  jiraIssueId: string,
): Promise<{ id: number; hierarchyLevel: JiraHierarchyLevel } | null> {
  return client.jiraTicket.findFirst({
    where: { screenId, jiraIssueId },
    select: { id: true, hierarchyLevel: true },
  });
}

/** Columns a synchronization may write (D-97); `lastSyncedAt` always goes with them. */
export type SyncChanges = Partial<{
  jiraIssueKey: string;
  issueType: string;
  summary: string;
  status: string;
  statusCategory: JiraStatusCategory;
  parentTicketId: number;
  parentLevel: JiraHierarchyLevel;
}>;

/** Writes the changed columns and moves `last_synced_at`. */
export async function writeSync(
  client: Pick<JiraTicketsClient, 'jiraTicket'>,
  id: number,
  changes: SyncChanges,
  syncedAt: Date,
): Promise<void> {
  await client.jiraTicket.update({ where: { id }, data: { ...changes, lastSyncedAt: syncedAt } });
}

/** Deletes a ticket; the foreign key of the parent (Table 30) deletes its children. */
export async function deleteTicket(client: Pick<JiraTicketsClient, 'jiraTicket'>, id: number): Promise<void> {
  await client.jiraTicket.delete({ where: { id } });
}
