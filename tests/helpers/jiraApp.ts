/**
 * The application wired to the in-process Jira simulator (never the real Jira), for the tests of the Jira operations:
 * `startJiraApp()` starts the simulator, points the configuration and the Jira client to it and exposes the control
 * endpoints of the simulator (`/__sim/*`) and a few readers of what the simulator and the database hold.
 */
import {
  createJiraClient,
  type JiraClient,
  type JiraClientDeps,
  type JiraClientOptions,
} from '../../src/integrations/jira/index.js';
import { startTestApp, type TestApp } from './app.js';
import { startJiraSimulator, type JiraSimulator } from './jiraSimulator.js';

/** An issue as `GET /__sim/state` lists it. */
export type SimIssue = {
  id: string;
  key: string;
  summary: string;
  level: 'EPIC' | 'STANDARD' | 'SUBTASK';
  status: string;
  parentKey: string | null;
};

/** What `GET /__sim/state` returns (the part the tests read). */
export type SimState = {
  issues: SimIssue[];
  calls: { method: string; path: string; authorized: boolean; fault: string | null; status: number }[];
};

/** A `jira_ticket` row as the tests read it from the database. */
export type TicketRowInDb = {
  id: number;
  screen_id: number;
  jira_issue_key: string;
  hierarchy_level: 'EPIC' | 'STANDARD' | 'SUBTASK';
  issue_type: string;
  parent_ticket_id: number | null;
  summary: string;
  status: string;
  status_category: 'TO_DO' | 'IN_PROGRESS' | 'DONE';
  created_by: number;
};

export type JiraApp = TestApp & {
  sim: JiraSimulator;
  /** The Jira client the application uses. */
  jira: JiraClient;
  /** Calls a control endpoint of the simulator. */
  control: (path: string, body?: unknown) => Promise<void>;
  /** Everything the simulator holds and every call it received. */
  simState: () => Promise<SimState>;
  /** The creations (`POST /rest/api/3/issue`) the simulator received, whatever their answer. */
  createCalls: () => Promise<SimState['calls']>;
  /** Rows of `jira_ticket` of a screen, by id. */
  ticketsOf: (screenId: number) => Promise<TicketRowInDb[]>;
  /** Closes the application, the database and the simulator. */
  closeAll: () => Promise<void>;
};

/** Options of {@link startJiraApp}. */
export type JiraAppOptions = {
  /** Thresholds of the client that differ from SDD Table 60 (for example a short timeout). */
  client?: Partial<JiraClientOptions>;
  /** Replaces pieces of the client's environment (for example a `fetch` that pauses before the request). */
  deps?: (base: JiraClientDeps) => JiraClientDeps;
  /** Environment variables replaced or removed (undefined) in the configuration of the application. */
  env?: Record<string, string | undefined>;
};

/** Starts the simulator, the database and the application. */
export async function startJiraApp(options: JiraAppOptions = {}): Promise<JiraApp> {
  const sim = await startJiraSimulator();
  const cfg = sim.jiraConfig();
  const env: Record<string, string | undefined> = {
    JIRA_BASE_URL: cfg.baseUrl,
    JIRA_EMAIL: cfg.email,
    JIRA_API_TOKEN: cfg.apiToken,
    JIRA_PROJECT_KEY: cfg.projectKey,
    JIRA_ISSUETYPE_EPIC_ID: cfg.issueTypeEpicId,
    JIRA_ISSUETYPE_STORY_ID: cfg.issueTypeStoryId,
    JIRA_ISSUETYPE_SUBTASK_ID: cfg.issueTypeSubtaskId,
    JIRA_WEBHOOK_SECRET: cfg.webhookSecret,
    ...options.env,
  };
  const defined = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined)) as Record<string, string>;
  const config = { ...cfg, ...(env['JIRA_PROJECT_KEY'] === undefined ? { projectKey: undefined } : {}) };
  let jira!: JiraClient;
  const t = await startTestApp({
    env: defined,
    jira: (logger) => {
      jira = createJiraClient(config, options.deps?.({ logger }) ?? { logger }, options.client);
      return jira;
    },
  });
  const request = async (path: string, method: string, body?: unknown): Promise<unknown> => {
    const res = await fetch(`${sim.baseUrl}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? null : JSON.stringify(body),
    });
    const text = await res.text();
    return text === '' ? null : (JSON.parse(text) as unknown);
  };
  const simState = async (): Promise<SimState> => (await request('/__sim/state', 'GET')) as SimState;
  return Object.assign(t, {
    sim,
    jira,
    control: async (path: string, body: unknown = {}) => void (await request(path, 'POST', body)),
    simState,
    createCalls: async () =>
      (await simState()).calls.filter((c) => c.method === 'POST' && c.path === '/rest/api/3/issue'),
    ticketsOf: async (screenId: number) =>
      (
        await t.owner.query<TicketRowInDb>(
          `SELECT id, screen_id, jira_issue_key, hierarchy_level, issue_type, parent_ticket_id, summary, status,
                  status_category, created_by FROM jira_ticket WHERE screen_id = $1 ORDER BY id`,
          [screenId],
        )
      ).rows,
    closeAll: async () => {
      await t.close();
      await sim.close();
    },
  });
}
