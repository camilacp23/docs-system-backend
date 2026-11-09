/**
 * `npm run sandbox:graph -- [--nodes <50-1000>] [--prefix <text>]`: loads an application of about 500 nodes (all node
 * and edge kinds, cycles of DERIVES_FROM and NAVIGATES_TO) into the local sandbox through its API, so the dependency map
 * can be demonstrated at department scale. Needs `npm run sandbox:db` and `npm run sandbox:api` running.
 *
 * It only talks to http://localhost:3001/api/v1, it refuses to write unless it finds the application "Sandbox
 * Fixtures", and it never prints the credentials it reads from the git-ignored file of the Bruno collection. Each run
 * creates its own application ("Graph demo <prefix>"), so it can run twice on the same sandbox. The work is in
 * `runSandboxGraphCli` (scripts/lib/sandboxGraph.ts), which the tests run too.
 */
import { SANDBOX_ENV_FILE } from './lib/sandbox.js';
import { runSandboxGraphCli } from './lib/sandboxGraph.js';

process.exitCode = await runSandboxGraphCli(process.argv.slice(2), { envFile: SANDBOX_ENV_FILE });
