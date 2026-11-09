/**
 * `npm run sandbox:api`: starts the API on port 3001 against `docs_sandbox` (see scripts/lib/sandbox.ts for the
 * environment). Stays in the foreground; Ctrl+C stops it. Run `npm run sandbox:db` first, and `npm run sandbox:jira` to
 * have a Jira simulator to talk to (without it the API still starts, with jiraAvailable = false).
 *
 * It runs the server in this same process so one signal (or one `kill`) stops everything.
 */
import { assertLocalJiraBaseUrl } from '../tests/helpers/jiraGuard.js';
import { sandboxApiEnv, SANDBOX_DB, SANDBOX_PORT } from './lib/sandbox.js';

Object.assign(process.env, sandboxApiEnv());
// The development .env may hold the real Jira: whatever reaches the server must be the simulator, or nothing.
assertLocalJiraBaseUrl(process.env['JIRA_BASE_URL'], 'sandbox API');
console.log(`Sandbox API: http://localhost:${SANDBOX_PORT}/api/v1 (database ${SANDBOX_DB})`);
// Imported after the environment is set: the server reads it on import. A static import would be hoisted above it.
await import('../src/server.js');
