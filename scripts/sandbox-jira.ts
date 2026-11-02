/**
 * `npm run sandbox:jira`: starts the local Jira simulator on port 3002 with the per-run credentials that
 * `npm run sandbox:db` wrote (the sandbox API reads the same ones). It stays in the foreground; Ctrl+C or one `kill`
 * stops it. The simulator listens on 127.0.0.1 only and nothing here can reach a real Jira.
 */
import { readSandboxJira, SANDBOX_JIRA_PORT } from './lib/sandbox.js';
import { startJiraSimulator } from '../tests/helpers/jiraSimulator.js';

const jira = readSandboxJira();
if (jira === null) {
  console.error('The Jira simulator settings are missing: run `npm run sandbox:db` first.');
  process.exit(2);
}

const sim = await startJiraSimulator({
  port: SANDBOX_JIRA_PORT,
  email: jira.email,
  apiToken: jira.apiToken,
  webhookSecret: jira.webhookSecret,
});
console.log(`Jira simulator: ${sim.baseUrl} (control endpoints under /__sim/)`);

const stop = (): void => {
  void sim.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
