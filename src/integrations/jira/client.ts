/**
 * Jira Cloud REST v3 client (SRS 3.9, SDD Table 29 and Table 60, D-45, D-89).
 *
 * Isolated from the rest of the system (NFR-14): 10 s timeout per attempt, up to 2 retries for reads only (never for
 * creation, which is not idempotent), a circuit breaker (5 failures, 60 s) and typed errors that know nothing about the
 * HTTP of this API. Uses the native `fetch`; never follows redirects; never logs the token, the Authorization header,
 * the e-mail, URLs, keys or bodies.
 *
 * Only `POST /rest/api/3/issue`, `GET /rest/api/3/issue/{idOrKey}` and `POST /rest/api/3/search/jql` are used. The
 * retired `/rest/api/3/search` must never be called.
 *
 * @module integrations/jira/client
 */
import type { JiraConfig } from '../../config/env.js';
import { buildDescription } from './adf.js';
import { assertJiraBaseUrl } from './baseUrl.js';
import { CircuitBreaker } from './circuitBreaker.js';
import {
  JiraConfigurationError,
  JiraError,
  JiraNotConfiguredError,
  JiraProtocolError,
  JiraRequestError,
  JiraUnavailableError,
  JiraValidationError,
} from './errors.js';
import { parseIssue } from './mapping.js';
import type {
  JiraClientStatus,
  JiraCreatedIssue,
  JiraCreateIssueInput,
  JiraHierarchyLevel,
  JiraIssue,
  JiraSearchPage,
} from './types.js';

/** Thresholds of SDD Table 60 (plus the backoff of D-89's approval): configuration values, injectable in tests. */
export type JiraClientOptions = {
  /** Timeout of each attempt. */
  timeoutMs: number;
  /** Retries of a read after the first attempt. */
  maxReadRetries: number;
  /** First backoff; doubles on every retry. No jitter. */
  backoffBaseMs: number;
  /** A `Retry-After` longer than this is not waited for: the call fails with RATE_LIMITED. */
  maxRetryAfterMs: number;
  /** Consecutive failures that open the circuit. */
  breakerFailureThreshold: number;
  /** Time the circuit stays open. */
  breakerOpenMs: number;
  /** True when `NODE_ENV=production`: plain HTTP is refused. */
  production: boolean;
};

export const JIRA_CLIENT_DEFAULTS: Readonly<JiraClientOptions> = {
  timeoutMs: 10_000,
  maxReadRetries: 2,
  backoffBaseMs: 500,
  maxRetryAfterMs: 10_000,
  breakerFailureThreshold: 5,
  breakerOpenMs: 60_000,
  production: false,
};

/** Minimal logger (a pino logger fits). */
export type JiraLogger = Record<'debug' | 'info' | 'warn' | 'error', (obj: object, msg: string) => void>;

/** Things the client takes from the environment, replaced in tests. */
export type JiraClientDeps = {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  logger?: JiraLogger;
};

/** What the client offers to the services. */
export type JiraClient = {
  /** False when Jira is not configured or the circuit is open (SDD 8.2). */
  readonly jiraAvailable: boolean;
  status(): JiraClientStatus;
  createIssue(input: JiraCreateIssueInput): Promise<JiraCreatedIssue>;
  getIssue(idOrKey: string): Promise<JiraIssue>;
  /** `singleAttempt: true` sends the search once, without retries (D-94); it still counts for the circuit breaker. */
  searchIssues(query: {
    jql: string;
    maxResults?: number;
    nextPageToken?: string;
    singleAttempt?: boolean;
  }): Promise<JiraSearchPage>;
};

const ISSUE_FIELDS = ['summary', 'status', 'issuetype', 'parent'] as const;
const KEY_PATTERN = /^[A-Z][A-Z0-9_]+-\d+$/;
const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,19}$/;
const ID_OR_KEY_PATTERN = /^(\d+|[A-Z][A-Z0-9_]+-\d+)$/;
const SUMMARY_MAX = 255;
const SEARCH_MAX_RESULTS = 100;
const noop = (): void => undefined;
const SILENT_LOGGER: JiraLogger = { debug: noop, info: noop, warn: noop, error: noop };
const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Names of the Jira variables that are not set (for the start-up warning; never their values).
 *
 * @param jira - The `jira` section of the configuration.
 * @returns Variable names, in the order of `.env.example`.
 */
export function missingJiraSettings(jira: JiraConfig): string[] {
  const all: [string, unknown][] = [
    ['JIRA_BASE_URL', jira.baseUrl],
    ['JIRA_EMAIL', jira.email],
    ['JIRA_API_TOKEN', jira.apiToken],
    ['JIRA_PROJECT_KEY', jira.projectKey],
    ['JIRA_ISSUETYPE_EPIC_ID', jira.issueTypeEpicId],
    ['JIRA_ISSUETYPE_STORY_ID', jira.issueTypeStoryId],
    ['JIRA_ISSUETYPE_SUBTASK_ID', jira.issueTypeSubtaskId],
    ['JIRA_WEBHOOK_SECRET', jira.webhookSecret],
  ];
  return all.filter(([, v]) => v === undefined).map(([name]) => name);
}

/** Variables a call needs: the connection for reads, plus the project and the issue types to create. */
const CONNECTION = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'];
const CREATION = [
  ...CONNECTION,
  'JIRA_PROJECT_KEY',
  'JIRA_ISSUETYPE_EPIC_ID',
  'JIRA_ISSUETYPE_STORY_ID',
  'JIRA_ISSUETYPE_SUBTASK_ID',
];

/** Per-call variations of {@link call}. */
type CallOptions = {
  /** A read sent once, without retries. */
  singleAttempt?: boolean;
  /** The project comes with the call, so `JIRA_PROJECT_KEY` is not needed. */
  projectGiven?: boolean;
};

type Attempt = { kind: 'ok'; body: unknown } | { kind: 'fail'; error: JiraError; retryAfterMs?: number | undefined };

/**
 * Creates the client.
 *
 * @param jira - Jira section of the configuration (everything optional, D-89).
 * @param deps - `fetch`, clock, sleep and logger; defaults to the real ones.
 * @param overrides - Thresholds that differ from SDD Table 60 (tests).
 * @returns The client. It never throws for missing settings: its calls do (JiraNotConfiguredError).
 * @throws {Error} When `jira.baseUrl` is set but not allowed (see `assertJiraBaseUrl`).
 */
export function createJiraClient(
  jira: JiraConfig,
  deps: JiraClientDeps = {},
  overrides: Partial<JiraClientOptions> = {},
): JiraClient {
  const options: JiraClientOptions = { ...JIRA_CLIENT_DEFAULTS, ...overrides };
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const log = deps.logger ?? SILENT_LOGGER;
  const baseUrl =
    jira.baseUrl === undefined ? undefined : assertJiraBaseUrl(jira.baseUrl, { production: options.production });
  const authorization =
    jira.email !== undefined && jira.apiToken !== undefined
      ? `Basic ${Buffer.from(`${jira.email}:${jira.apiToken}`).toString('base64')}`
      : undefined;
  const breaker = new CircuitBreaker({
    failureThreshold: options.breakerFailureThreshold,
    openMs: options.breakerOpenMs,
    now,
  });
  const missing = new Set(missingJiraSettings(jira));
  let lastFailure: string | null = null;

  const missingFor = (needed: string[]): string[] => needed.filter((n) => missing.has(n));

  /** One HTTP attempt: resolves to the parsed body, or to the classified failure. Never throws. */
  async function attempt(operation: string, method: string, path: string, body: unknown): Promise<Attempt> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);
    try {
      const init: RequestInit = {
        method,
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Authorization: authorization ?? '',
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      const res = await doFetch(`${baseUrl ?? ''}${path}`, init);
      const status = res.status;
      if (status >= 300 && status < 400) return { kind: 'fail', error: new JiraUnavailableError('REDIRECT', status) };
      if (status === 401) return { kind: 'fail', error: new JiraConfigurationError('AUTH_REJECTED', 401) };
      if (status === 403) return { kind: 'fail', error: new JiraConfigurationError('FORBIDDEN', 403) };
      if (status === 429) {
        const wait = parseRetryAfter(res.headers.get('retry-after'), now());
        return { kind: 'fail', error: new JiraUnavailableError('RATE_LIMITED', 429), retryAfterMs: wait };
      }
      if (status >= 500) return { kind: 'fail', error: new JiraUnavailableError('SERVER_ERROR', status) };
      const text = await res.text();
      if (status >= 400) return { kind: 'fail', error: new JiraRequestError(status, jiraMessages(text)) };
      try {
        return { kind: 'ok', body: text === '' ? null : (JSON.parse(text) as unknown) };
      } catch {
        return { kind: 'fail', error: new JiraUnavailableError('BAD_RESPONSE', status) };
      }
    } catch {
      return { kind: 'fail', error: new JiraUnavailableError(timedOut ? 'TIMEOUT' : 'NETWORK') };
    } finally {
      clearTimeout(timer);
      log.debug({ operation }, 'jira attempt finished');
    }
  }

  /** Runs a call through configuration check, circuit breaker, timeout and (reads only) retries. */
  async function call(
    operation: string,
    kind: 'read' | 'create',
    method: string,
    path: string,
    body?: unknown,
    callOptions: CallOptions = {},
  ): Promise<unknown> {
    const needed = kind === 'create' ? CREATION : CONNECTION;
    const absent = missingFor(
      callOptions.projectGiven === true ? needed.filter((n) => n !== 'JIRA_PROJECT_KEY') : needed,
    );
    if (absent.length > 0) throw new JiraNotConfiguredError(absent);

    const { probe } = breaker.acquire();
    const maxAttempts =
      kind === 'read' && !probe && callOptions.singleAttempt !== true ? 1 + options.maxReadRetries : 1;
    let backoff = options.backoffBaseMs;
    let outcome: Attempt = { kind: 'fail', error: new JiraUnavailableError('NETWORK') };

    for (let n = 1; n <= maxAttempts; n++) {
      const started = now();
      outcome = await attempt(operation, method, path, body);
      if (outcome.kind === 'ok') break;
      const err = outcome.error;
      log.warn({ operation, attempt: n, reason: err.reason, durationMs: now() - started, probe }, 'jira call failed');
      const retryable =
        err instanceof JiraUnavailableError &&
        ['NETWORK', 'TIMEOUT', 'SERVER_ERROR', 'RATE_LIMITED'].includes(err.reason);
      if (!retryable || n === maxAttempts) break;
      const wait = outcome.retryAfterMs ?? backoff;
      if (wait > options.maxRetryAfterMs) break; // Retry-After longer than we are willing to wait
      await sleep(wait);
      backoff *= 2;
    }

    if (outcome.kind === 'ok') {
      record(true, probe, operation);
      return outcome.body;
    }
    const error = outcome.error;
    record(!error.availability, probe, operation);
    if (error.availability) lastFailure = error.reason;
    if (error instanceof JiraConfigurationError) {
      log.error({ operation, reason: error.reason }, error.message);
    }
    throw error;
  }

  function record(ok: boolean, probe: boolean, operation: string): void {
    const transition = breaker.record(ok, probe);
    if (transition === 'opened') log.warn({ operation, openMs: options.breakerOpenMs }, 'jira circuit opened');
    if (transition === 'closed') log.info({ operation }, 'jira circuit closed');
    if (ok) lastFailure = null;
  }

  const client: JiraClient = {
    get jiraAvailable(): boolean {
      return missingFor(CONNECTION).length === 0 && breaker.state() !== 'open';
    },

    status(): JiraClientStatus {
      return { configured: missingFor(CONNECTION).length === 0, state: breaker.state(), lastFailure };
    },

    async createIssue(input: JiraCreateIssueInput): Promise<JiraCreatedIssue> {
      validateCreate(input);
      const typeIds: Record<JiraHierarchyLevel, string | undefined> = {
        EPIC: jira.issueTypeEpicId,
        STANDARD: jira.issueTypeStoryId,
        SUBTASK: jira.issueTypeSubtaskId,
      };
      const fields: Record<string, unknown> = {
        project: { key: input.projectKey ?? jira.projectKey },
        issuetype: { id: typeIds[input.level] },
        summary: input.summary,
        description: buildDescription(input.description, input.screen),
      };
      if (input.parentKey !== undefined) fields['parent'] = { key: input.parentKey };
      const raw = await call(
        'createIssue',
        'create',
        'POST',
        '/rest/api/3/issue',
        { fields },
        {
          projectGiven: input.projectKey !== undefined,
        },
      );
      const r = raw as Record<string, unknown> | null;
      if (r === null || typeof r !== 'object' || typeof r['id'] !== 'string' || typeof r['key'] !== 'string') {
        throw new JiraProtocolError('created issue');
      }
      return { id: r['id'], key: r['key'], self: typeof r['self'] === 'string' ? r['self'] : '' };
    },

    async getIssue(idOrKey: string): Promise<JiraIssue> {
      if (!ID_OR_KEY_PATTERN.test(idOrKey)) throw new JiraValidationError('issue id or key', 'unexpected format');
      const query = `fields=${ISSUE_FIELDS.join(',')}`;
      const raw = await call('getIssue', 'read', 'GET', `/rest/api/3/issue/${encodeURIComponent(idOrKey)}?${query}`);
      return parseIssue(raw);
    },

    async searchIssues(query): Promise<JiraSearchPage> {
      if (query.jql.trim() === '') throw new JiraValidationError('jql', 'is empty');
      const maxResults = Math.min(Math.max(query.maxResults ?? 50, 1), SEARCH_MAX_RESULTS);
      const body: Record<string, unknown> = { jql: query.jql, fields: [...ISSUE_FIELDS], maxResults };
      if (query.nextPageToken !== undefined) body['nextPageToken'] = query.nextPageToken;
      const raw = await call('searchIssues', 'read', 'POST', '/rest/api/3/search/jql', body, {
        singleAttempt: query.singleAttempt === true,
      });
      const r = raw as Record<string, unknown> | null;
      if (r === null || typeof r !== 'object' || !Array.isArray(r['issues']))
        throw new JiraProtocolError('search result');
      const issues: JiraIssue[] = [];
      const skipped: string[] = [];
      for (const item of r['issues'] as unknown[]) {
        try {
          issues.push(parseIssue(item));
        } catch (e) {
          if (!(e instanceof JiraProtocolError)) throw e;
          const key = (item as { key?: unknown } | null)?.key;
          skipped.push(typeof key === 'string' ? key : '?');
        }
      }
      const next = r['nextPageToken'];
      return { issues, nextPageToken: typeof next === 'string' && next !== '' ? next : null, skipped };
    },
  };
  return client;
}

/**
 * JQL that selects issues by key (keys are validated, so nothing else can be injected).
 *
 * @param keys - Issue keys such as `TECHEA-12`.
 * @returns `key in (TECHEA-1, TECHEA-2)`.
 * @throws {JiraValidationError} When the list is empty or a key has an unexpected format.
 */
export function keysJql(keys: readonly string[]): string {
  if (keys.length === 0) throw new JiraValidationError('keys', 'is empty');
  for (const k of keys) if (!KEY_PATTERN.test(k)) throw new JiraValidationError('key', 'unexpected format');
  return `key in (${keys.join(', ')})`;
}

function validateCreate(input: JiraCreateIssueInput): void {
  const summary = input.summary;
  if (summary.trim() === '') throw new JiraValidationError('summary', 'is empty');
  if (summary.length > SUMMARY_MAX)
    throw new JiraValidationError('summary', `is longer than ${SUMMARY_MAX} characters`);
  if (/[\r\n]/.test(summary)) throw new JiraValidationError('summary', 'must be a single line');
  if (input.projectKey !== undefined && !PROJECT_KEY_PATTERN.test(input.projectKey))
    throw new JiraValidationError('project', 'unexpected format');
  if (input.level === 'EPIC') {
    if (input.parentKey !== undefined) throw new JiraValidationError('parent', 'an Epic has no parent');
    return;
  }
  if (input.parentKey === undefined) throw new JiraValidationError('parent', 'is required for a Story or a Subtask');
  if (!KEY_PATTERN.test(input.parentKey)) throw new JiraValidationError('parent', 'unexpected format');
}

/** Milliseconds from a `Retry-After` header (seconds or HTTP date), or undefined when absent or unreadable. */
function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const date = Date.parse(text);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}

/** Messages Jira put in an error body (`errorMessages` and the values of `errors`). */
function jiraMessages(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as { errorMessages?: unknown; errors?: unknown };
    const list: unknown[] = Array.isArray(parsed.errorMessages) ? (parsed.errorMessages as unknown[]) : [];
    const fields: unknown[] =
      parsed.errors !== null && typeof parsed.errors === 'object' ? Object.values(parsed.errors) : [];
    return [...list, ...fields].filter((m): m is string => typeof m === 'string');
  } catch {
    return [];
  }
}
