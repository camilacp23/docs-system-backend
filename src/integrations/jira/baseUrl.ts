/**
 * Restriction of the Jira base URL (NFR-04): HTTPS only, except `http://localhost` and `http://127.0.0.1`, which exist
 * for the local Jira simulator and are refused in production. Shared by the configuration loader and the client so
 * the rule lives in one place. Reasons never include the URL, which may carry a host the operator considers private.
 *
 * @module integrations/jira/baseUrl
 */

/** Hosts that may be reached over plain HTTP (the local Jira simulator). */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1']);

/** Options of {@link jiraBaseUrlProblem}. */
export type JiraBaseUrlOptions = {
  /** True when `NODE_ENV=production`: plain HTTP is refused even for localhost. */
  production?: boolean;
};

/**
 * True when the URL parses and points to `localhost` or `127.0.0.1` (any scheme, any port).
 *
 * @param value - URL text.
 * @returns Whether the host is exactly one of the local hosts.
 */
export function isLocalJiraBaseUrl(value: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

/**
 * Checks a Jira base URL.
 *
 * @param value - URL text, e.g. `https://site.atlassian.net`.
 * @param options - Environment flags.
 * @returns A reason (never containing the URL) when it is not allowed, or `null` when it is.
 */
export function jiraBaseUrlProblem(value: string, options: JiraBaseUrlOptions = {}): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return 'must be a valid URL';
  }
  if (parsed.username !== '' || parsed.password !== '') return 'must not contain credentials';
  if (parsed.search !== '' || parsed.hash !== '') return 'must not contain a query or a fragment';
  if (parsed.protocol === 'https:') return null;
  if (parsed.protocol === 'http:' && LOCAL_HOSTS.has(parsed.hostname)) {
    return options.production === true ? 'must use https in production (NFR-04)' : null;
  }
  return 'must use https (http is accepted only for localhost or 127.0.0.1)';
}

/**
 * Throws unless the URL is allowed (see {@link jiraBaseUrlProblem}).
 *
 * @param value - URL text.
 * @param options - Environment flags.
 * @returns The URL without a trailing slash.
 * @throws {Error} With the reason; the message never includes the URL.
 */
export function assertJiraBaseUrl(value: string, options: JiraBaseUrlOptions = {}): string {
  const problem = jiraBaseUrlProblem(value, options);
  if (problem !== null) throw new Error(`Jira base URL ${problem}`);
  return value.replace(/\/+$/, '');
}
