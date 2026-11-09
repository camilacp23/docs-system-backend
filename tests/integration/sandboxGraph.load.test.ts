/**
 * `npm run sandbox:graph` against the real API on a disposable database (the script itself never runs on the sandbox
 * here): the load of about 500 nodes is accepted by every rule of the API, and the graph it returns matches the plan.
 * A second run with another prefix does not collide with the first.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { assertConformsToContract } from '../helpers/contractResponse.js';
import { insertApplication } from '../helpers/fixtures.js';
import { runSandboxGraph, SANDBOX_FIXTURES_NAME, type SandboxApi } from '../../scripts/lib/sandboxGraph.js';
import { asUser } from '../helpers/users.js';

describe('sandbox:graph load', () => {
  let t: TestApp;

  before(async () => {
    t = await startTestApp();
    try {
      await insertApplication(t, { name: SANDBOX_FIXTURES_NAME });
    } catch (error) {
      await t.close();
      throw error;
    }
  });
  after(async () => {
    await t.close();
  });

  /** The script's API port, served by the application under test as the administrator. */
  const api = (): SandboxApi => {
    const admin = asUser(t, t.users.admin.token);
    const lower = (headers: Record<string, unknown>): Record<string, string> =>
      Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
    return {
      get: async (path) => {
        const res = await admin.get(path);
        return { status: res.status, body: res.body as unknown, headers: lower(res.headers) };
      },
      send: async (method, path, body, headers = {}) => {
        const request = method === 'POST' ? admin.post(path, body as object) : admin.put(path, body as object);
        for (const [key, value] of Object.entries(headers)) void request.set(key, value);
        const res = await request;
        return { status: res.status, body: res.body as unknown, headers: lower(res.headers) };
      },
    };
  };

  it('loads 500 nodes with every kind of edge, the API accepts all of it and the graph matches the plan', async () => {
    const result = await runSandboxGraph(api(), { nodes: 500, prefix: 'first1' });
    assert.equal(result.matches, true, JSON.stringify({ expected: result.expected, actual: result.actual }));
    assert.deepEqual(result.actual.nodes, { SCREEN: 40, VARIABLE: 120, COLLECTION: 60, COMPONENT: 280 });
    assert.deepEqual(result.actual.edges, {
      CONTAINS: 280,
      CREATES: 100,
      ACCESSES: 312,
      FEEDS: 60,
      USES: 280,
      DERIVES_FROM: 60,
      NAVIGATES_TO: 39,
    });
    const res = await asUser(t, t.users.admin.token).get(`/dependencies/graph?applicationId=${result.applicationId}`);
    await assertConformsToContract(res);
    console.log(
      `[sandbox:graph] ${result.requests} requests; GET /dependencies/graph ${result.graphReadMs.toFixed(1)} ms; ` +
        `neighborhood of the first collection (depth 2): ${result.neighborhood.nodes} nodes`,
    );
  });

  it('a second run with another prefix creates its own application and does not collide', async () => {
    const second = await runSandboxGraph(api(), { nodes: 100, prefix: 'second2' });
    assert.equal(second.matches, true);
    assert.equal(second.applicationName, 'Graph demo second2');
    const first = await asUser(t, t.users.admin.token).get('/applications?q=Graph%20demo&pageSize=100');
    assert.equal((first.body as { total: number }).total, 2);
  });
});
