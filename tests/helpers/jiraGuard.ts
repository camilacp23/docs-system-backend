/**
 * Safeguard: tests, the sandbox and Bruno must never reach the real Jira. Anything that configures a Jira base URL
 * for them goes through here and is refused unless it points to localhost or 127.0.0.1 (the Jira simulator).
 * The messages never include the URL.
 *
 * @module tests/helpers/jiraGuard
 */
import type { JiraConfig } from '../../src/config/env.js';
import { isLocalJiraBaseUrl } from '../../src/integrations/jira/baseUrl.js';

/** Names of every Jira variable of `.env.example`. */
export const JIRA_ENV_NAMES = [
  'JIRA_BASE_URL',
  'JIRA_EMAIL',
  'JIRA_API_TOKEN',
  'JIRA_PROJECT_KEY',
  'JIRA_ISSUETYPE_EPIC_ID',
  'JIRA_ISSUETYPE_STORY_ID',
  'JIRA_ISSUETYPE_SUBTASK_ID',
  'JIRA_WEBHOOK_SECRET',
] as const;

/**
 * Throws unless the value is absent or points to localhost / 127.0.0.1.
 *
 * @param value - A Jira base URL (undefined = Jira not configured, which is allowed).
 * @param where - Who is configuring it, for the message ("test application", "sandbox API", ...).
 */
export function assertLocalJiraBaseUrl(value: string | undefined, where: string): void {
  if (value === undefined || value.trim() === '') return;
  if (!isLocalJiraBaseUrl(value)) {
    throw new Error(
      `${where}: JIRA_BASE_URL must point to localhost or 127.0.0.1 (the Jira simulator), never to a real Jira`,
    );
  }
}

/**
 * Same check on a loaded configuration.
 *
 * @param jira - Jira section of the configuration.
 * @param where - Who is configuring it.
 */
export function assertJiraConfigIsLocal(jira: JiraConfig, where: string): void {
  assertLocalJiraBaseUrl(jira.baseUrl, where);
}
