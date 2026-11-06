/**
 * The representation of a stored Jira ticket (contract schema `JiraTicket`), shared by the creation and the tree.
 *
 * @module modules/screens/jiraView
 */
import type { JiraHierarchyLevel } from '../../generated/prisma/client.js';
import type { TicketRow } from './jiraRepository.js';

/** A ticket as the API returns it (contract schema `JiraTicket`). */
export type JiraTicketView = {
  id: number;
  jiraIssueKey: string;
  hierarchyLevel: JiraHierarchyLevel;
  issueType: string;
  summary: string;
  status: string;
  statusCategory: TicketRow['statusCategory'];
  url: string;
  lastSyncedAt: Date;
};

/**
 * Builds the function that turns a stored row into its API representation.
 *
 * @param jiraBaseUrl - Base URL of Jira for the links (`<base>/browse/<key>`); undefined when not configured.
 */
export function createTicketView(jiraBaseUrl: string | undefined): (row: TicketRow) => JiraTicketView {
  const baseUrl = jiraBaseUrl?.replace(/\/+$/, '');
  return (row) => ({
    id: row.id,
    jiraIssueKey: row.jiraIssueKey,
    hierarchyLevel: row.hierarchyLevel,
    issueType: row.issueType,
    summary: row.summary,
    status: row.status,
    statusCategory: row.statusCategory,
    url: `${baseUrl ?? ''}/browse/${row.jiraIssueKey}`,
    lastSyncedAt: row.lastSyncedAt,
  });
}
