/**
 * `npm run sandbox:graph -- [--nodes <50-1000>] [--prefix <text>]`: loads an application of about 500 nodes (all node
 * and edge kinds, cycles of DERIVES_FROM and NAVIGATES_TO) into the local sandbox through its API, so the dependency map
 * can be demonstrated at department scale. Needs `npm run sandbox:db` and `npm run sandbox:api` running.
 *
 * It only talks to http://localhost:3001/api/v1, it refuses to write unless it finds the application "Sandbox
 * Fixtures", and it never prints the credentials it reads from the git-ignored file of the Bruno collection. Each run
 * creates its own application ("Graph demo <prefix>"), so it can run twice on the same sandbox.
 */
import { SANDBOX_ENV_FILE } from './lib/sandbox.js';
import {
  createSandboxApi,
  parseGraphArgs,
  readSandboxAdmin,
  runSandboxGraph,
  SANDBOX_GRAPH_BASE_URL,
} from './lib/sandboxGraph.js';

try {
  const options = parseGraphArgs(process.argv.slice(2));
  const api = await createSandboxApi(SANDBOX_GRAPH_BASE_URL, readSandboxAdmin(SANDBOX_ENV_FILE));
  const result = await runSandboxGraph(api, options, (line) => console.log(line));

  const row = (counts: Record<string, number>) =>
    Object.entries(counts)
      .map(([key, n]) => `${key}=${n}`)
      .join(', ');
  console.log('');
  console.log(`Application: ${result.applicationName} (id ${result.applicationId}), prefix ${options.prefix}`);
  console.log(`Nodes: ${row(result.actual.nodes)}`);
  console.log(`Edges: ${row(result.actual.edges)}`);
  console.log(`The graph matches the plan: ${result.matches ? 'yes' : 'NO'}`);
  console.log(`GET /dependencies/graph took ${result.graphReadMs.toFixed(1)} ms (${result.requests} requests in all)`);
  console.log('');
  console.log('To look at it:');
  console.log(`  GET ${SANDBOX_GRAPH_BASE_URL}/dependencies/graph?applicationId=${result.applicationId}`);
  console.log(
    `  GET ${SANDBOX_GRAPH_BASE_URL.replace('/api/v1', '')}${result.neighborhood.path}  (${result.neighborhood.nodes} nodes)`,
  );
  if (!result.matches) {
    console.error(`Expected nodes ${row(result.expected.nodes)} and edges ${row(result.expected.edges)}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
