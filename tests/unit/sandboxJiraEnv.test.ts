/** The sandbox API never receives the real Jira that the development .env may hold. */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { loadConfig } from '../../src/config/index.js';
import { JIRA_ENV_NAMES } from '../helpers/jiraGuard.js';
import { SIMULATOR_DEFAULTS } from '../helpers/jiraSimulator.js';
import { sandboxApiEnv, sandboxJiraEnv, type SandboxJira } from '../../scripts/lib/sandbox.js';

const REAL: Record<string, string> = {
  JIRA_BASE_URL: 'https://real-site.atlassian.net',
  JIRA_EMAIL: 'real.person@company.example',
  JIRA_API_TOKEN: 'REAL-TOKEN-DO-NOT-LEAK',
  JIRA_PROJECT_KEY: 'REALPROJ',
  JIRA_ISSUETYPE_EPIC_ID: '1',
  JIRA_ISSUETYPE_STORY_ID: '2',
  JIRA_ISSUETYPE_SUBTASK_ID: '3',
  JIRA_WEBHOOK_SECRET: 'REAL-WEBHOOK-SECRET',
};
const SIM: SandboxJira = {
  baseUrl: 'http://127.0.0.1:3002',
  email: 'sandbox.jira@example.org',
  apiToken: 'sim-token',
  webhookSecret: 'sim-secret',
};

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries([...JIRA_ENV_NAMES, 'APP_DATABASE_URL'].map((n) => [n, process.env[n]]));
  Object.assign(process.env, REAL);
  process.env['APP_DATABASE_URL'] ??= 'postgresql://docs_app:x@localhost:5432/docs_system';
});
afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('sandboxApiEnv', () => {
  it('overrides every Jira variable of the environment, empty when there is no simulator', () => {
    const env = sandboxApiEnv(null);
    for (const name of JIRA_ENV_NAMES) assert.equal(env[name], '', name);
    assert.deepEqual(loadConfig(env).jira, {}, 'the API starts with Jira not configured');
  });

  it('points the API only at the simulator, with its own secrets and the simulator issue types', () => {
    const env = sandboxApiEnv(SIM);
    assert.equal(env['JIRA_BASE_URL'], SIM.baseUrl);
    assert.equal(env['JIRA_API_TOKEN'], SIM.apiToken);
    assert.equal(env['JIRA_WEBHOOK_SECRET'], SIM.webhookSecret);
    assert.equal(env['JIRA_PROJECT_KEY'], SIMULATOR_DEFAULTS.projectKey);
    assert.equal(env['JIRA_ISSUETYPE_STORY_ID'], SIMULATOR_DEFAULTS.issueTypeIds.story);
    const text = JSON.stringify(Object.fromEntries(JIRA_ENV_NAMES.map((n) => [n, env[n]])));
    for (const real of Object.values(REAL).filter((v) => v.length > 5))
      assert.equal(text.includes(real), false, real.slice(0, 6));
    assert.equal(loadConfig(env).jira.baseUrl, SIM.baseUrl);
  });

  it('refuses a Jira URL that is not local', () => {
    for (const baseUrl of [REAL['JIRA_BASE_URL']!, 'http://10.1.2.3:3002', 'https://localhost.evil.example']) {
      assert.throws(() => sandboxJiraEnv({ ...SIM, baseUrl }), /localhost or 127\.0\.0\.1/);
      assert.throws(() => sandboxApiEnv({ ...SIM, baseUrl }), /localhost or 127\.0\.0\.1/);
    }
  });
});
