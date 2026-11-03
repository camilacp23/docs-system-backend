/**
 * Shapes the Jira client takes and returns. Names follow the contract (`JiraHierarchyLevel`, `JiraStatusCategory`).
 *
 * @module integrations/jira/types
 */

/** Hierarchy of an issue type: Jira's `hierarchyLevel` 1, 0 and -1 (SDD Table 23). */
export type JiraHierarchyLevel = 'EPIC' | 'STANDARD' | 'SUBTASK';
/** Jira status category `new`, `indeterminate` and `done`. */
export type JiraStatusCategory = 'TO_DO' | 'IN_PROGRESS' | 'DONE';

/** What the system needs from an issue (SDD Table 23). */
export type JiraIssue = {
  id: string;
  key: string;
  summary: string;
  /** Workflow status name. */
  status: string;
  statusCategory: JiraStatusCategory;
  /** Display name of the issue type. */
  issueType: string;
  hierarchyLevel: JiraHierarchyLevel;
  /** Parent issue, when it has one. */
  parent: { id: string; key: string } | null;
};

/** Result of creating an issue (the only fields Jira returns). */
export type JiraCreatedIssue = { id: string; key: string; self: string };

/** The documented screen an issue comes from; goes into the ADF description. */
export type JiraScreenReference = { screenId: number; screenName: string; applicationName: string };

/** Input to {@link JiraClient.createIssue}. */
export type JiraCreateIssueInput = {
  level: JiraHierarchyLevel;
  summary: string;
  /** Plain text; each non-empty line becomes an ADF paragraph. */
  description?: string | undefined;
  screen: JiraScreenReference;
  /** Project key of this issue; defaults to `JIRA_PROJECT_KEY` (D-91). */
  projectKey?: string | undefined;
  /** Key of the parent: the Epic of a Story, the Story of a Subtask. Required for STANDARD and SUBTASK, forbidden for EPIC. */
  parentKey?: string | undefined;
};

/** One page of a JQL search. */
export type JiraSearchPage = {
  issues: JiraIssue[];
  /** Token of the next page, or null on the last one. */
  nextPageToken: string | null;
  /** Issues of the page that were left out because their data is not modelled (see {@link JiraProtocolError}). */
  skipped: string[];
};

/** Circuit breaker state. */
export type JiraBreakerState = 'closed' | 'open' | 'half-open';

/** Snapshot reported by {@link JiraClient.status}. */
export type JiraClientStatus = {
  configured: boolean;
  state: JiraBreakerState;
  /** Reason of the last failure that counted, or null. */
  lastFailure: string | null;
};
