/**
 * `npm run sandbox:graph`: the pure plan (counts, rings, links), the argument rules and the safeguards (another URL, or
 * no "Sandbox Fixtures" application, and nothing is written). No database, no server and no network: the API is a fake.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  assertSandboxBaseUrl,
  createSandboxApi,
  expectedGraph,
  formatApiError,
  feedsOf,
  isContext,
  isUntraced,
  linkableVariables,
  linksOf,
  originOf,
  parseGraphArgs,
  planGraph,
  readSandboxAdmin,
  ringNext,
  runSandboxGraph,
  SANDBOX_GRAPH_BASE_URL,
  useOf,
  type SandboxApi,
} from '../../scripts/lib/sandboxGraph.js';

describe('sandbox:graph plan', () => {
  it('500 nodes are 40 screens (with App (OnStart)), 120 variables, 60 collections and 280 components', () => {
    const plan = planGraph(500);
    assert.deepEqual(plan, { screens: 39, variables: 120, collections: 60, components: 280 });
    const expected = expectedGraph(plan);
    assert.equal(
      Object.values(expected.nodes).reduce((a, b) => a + b, 0),
      500,
    );
    assert.deepEqual(expected.nodes, { SCREEN: 40, VARIABLE: 120, COLLECTION: 60, COMPONENT: 280 });
  });

  it('has every kind of edge, with rings of the whole set for DERIVES_FROM and NAVIGATES_TO', () => {
    const { edges } = expectedGraph(planGraph(500));
    assert.deepEqual(edges, {
      CONTAINS: 280,
      CREATES: 100,
      ACCESSES: 312,
      FEEDS: 60,
      USES: 280,
      DERIVES_FROM: 60,
      NAVIGATES_TO: 39,
    });
    for (const size of [3, 39, 60]) {
      const seen = new Set<number>();
      let at = 0;
      for (let i = 0; i < size; i += 1) {
        seen.add(at);
        at = ringNext(at, size);
      }
      assert.equal(seen.size, size, 'one cycle through every element');
      assert.equal(at, 0, 'and it closes');
    }
  });

  it('holds for every size the script accepts', () => {
    for (const total of [50, 51, 100, 333, 500, 999, 1000]) {
      const plan = planGraph(total);
      const expected = expectedGraph(plan);
      assert.equal(
        Object.values(expected.nodes).reduce((a, b) => a + b, 0),
        total,
        String(total),
      );
      assert.ok(plan.screens >= 3 && plan.collections >= 4 && plan.components > 0, String(total));
      assert.ok(linkableVariables(plan).length >= 4, String(total));
      for (let s = 0; s < plan.screens; s += 1) {
        const links = linksOf(s, plan);
        assert.equal(new Set(links.variables).size, 4, `variables of screen ${s} (${total})`);
        assert.equal(new Set(links.collections).size, 4, `collections of screen ${s} (${total})`);
      }
    }
  });

  it('only global variables are linked, used or assigned; context variables have an origin; some have none', () => {
    const plan = planGraph(500);
    const linkable = new Set(linkableVariables(plan));
    assert.ok([...linkable].every((v) => !isContext(v)));
    for (const feed of feedsOf(plan)) assert.ok(linkable.has(feed.variable));
    for (let k = 0; k < plan.components; k += 1) {
      const use = useOf(k, plan);
      if (use.type === 'VARIABLE') assert.ok(linkable.has(use.index));
    }
    const contexts = Array.from({ length: plan.variables }, (_, v) => v).filter(isContext);
    assert.ok(contexts.length > 0 && contexts.every((v) => originOf(v, plan) !== null));
    assert.ok(
      Array.from({ length: plan.variables }, (_, v) => v)
        .filter(isUntraced)
        .every((v) => originOf(v, plan) === null),
    );
  });
});

describe('sandbox:graph arguments', () => {
  const fixed = () => 'abc123';
  it('defaults to 500 nodes and a random prefix', () => {
    assert.deepEqual(parseGraphArgs([], fixed), { nodes: 500, prefix: 'abc123' });
    assert.deepEqual(parseGraphArgs(['--nodes', '200', '--prefix', 'demo1'], fixed), { nodes: 200, prefix: 'demo1' });
  });
  it('the default random prefix always makes valid variable and collection names (they start with a letter)', () => {
    const contractName = /^[A-Za-z_][A-Za-z0-9_]*$/; // pattern of VariableWrite.name and CollectionWrite.name
    for (let i = 0; i < 2000; i += 1) {
      const { prefix } = parseGraphArgs([]);
      assert.match(`${prefix}Var0`, contractName, prefix);
      assert.match(`${prefix}Col0`, contractName, prefix);
    }
  });
  it('rejects a prefix that starts with a digit, such as 2cc16a, before it writes anything', () => {
    assert.throws(() => parseGraphArgs(['--prefix', '2cc16a']), /--prefix must start with a letter/);
    assert.throws(() => parseGraphArgs([], () => '2cc16a'), /--prefix must start with a letter/);
  });
  it('rejects a size outside the range, a bad prefix and every other option (also a URL or a database)', () => {
    for (const bad of [
      ['--nodes', '49'],
      ['--nodes', '1001'],
      ['--nodes', 'x'],
      ['--nodes', '12.5'],
    ]) {
      assert.throws(() => parseGraphArgs(bad, fixed), /--nodes/);
    }
    assert.throws(() => parseGraphArgs(['--prefix', 'a b'], fixed), /--prefix/);
    assert.throws(() => parseGraphArgs(['--prefix', 'ab'], fixed), /--prefix/);
    for (const flag of ['--url', '--base-url', '--database', '--db', '--help']) {
      assert.throws(() => parseGraphArgs([flag, 'http://localhost:3000/api/v1'], fixed), /Unknown option/);
    }
  });
});

describe('sandbox:graph safeguards', () => {
  it('refuses any API but the sandbox one', async () => {
    assertSandboxBaseUrl(SANDBOX_GRAPH_BASE_URL);
    for (const url of [
      'http://localhost:3000/api/v1',
      'http://localhost:3001/api/v1/',
      'http://127.0.0.1:3001/api/v1',
      'https://localhost:3001/api/v1',
      'http://localhost:3001.example.org/api/v1',
      'https://docs.example.org/api/v1',
      '',
    ]) {
      assert.throws(() => assertSandboxBaseUrl(url), /Refusing to run/, url);
      await assert.rejects(createSandboxApi(url, { email: 'a@b.co', password: 'x' }), /Refusing to run/, url);
    }
  });

  /** A fake API that records every call and answers the list of applications as given. */
  function fakeApi(applications: { id: number; name: string }[]) {
    const calls: string[] = [];
    const api: SandboxApi = {
      get: (path) => {
        calls.push(`GET ${path}`);
        return Promise.resolve({ status: 200, body: { data: applications }, headers: {} });
      },
      send: (method, path) => {
        calls.push(`${method} ${path}`);
        return Promise.resolve({
          status: 500,
          body: { code: 'INTERNAL_ERROR', message: 'should not be called' },
          headers: {},
        });
      },
    };
    return { api, calls };
  }

  it('without the application "Sandbox Fixtures" it reads, refuses, and writes nothing', async () => {
    for (const apps of [[], [{ id: 1, name: 'Production system' }], [{ id: 2, name: 'Sandbox Fixtures 2' }]]) {
      const { api, calls } = fakeApi(apps);
      await assert.rejects(
        runSandboxGraph(api, { nodes: 500, prefix: 'abc123' }),
        /Refusing to write.*Sandbox Fixtures/,
      );
      assert.equal(calls.length, 1);
      assert.match(calls[0]!, /^GET \/applications\?q=Sandbox%20Fixtures/);
    }
  });

  it('with the application it starts to write (the fake then rejects the first POST)', async () => {
    const { api, calls } = fakeApi([{ id: 1, name: 'Sandbox Fixtures' }]);
    await assert.rejects(runSandboxGraph(api, { nodes: 500, prefix: 'abc123' }), /Creating the application/);
    assert.deepEqual(calls.slice(1), ['POST /applications']);
  });
});

describe('sandbox:graph credentials', () => {
  it('reads the administrator from the credentials file, and says what to do when it is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sandbox-graph-'));
    try {
      const file = join(dir, '.env');
      assert.throws(() => readSandboxAdmin(file), /sandbox:db/);
      writeFileSync(file, 'SANDBOX_JIRA_API_TOKEN=zzz\n');
      assert.throws(() => readSandboxAdmin(file), /sandbox:db/);
      writeFileSync(
        file,
        'SANDBOX_ADMIN_EMAIL=admin@sandbox.local\nSANDBOX_ADMIN_PASSWORD=not-a-real-password\nOTHER=1\n',
      );
      assert.deepEqual(readSandboxAdmin(file), { email: 'admin@sandbox.local', password: 'not-a-real-password' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sandbox:graph error report', () => {
  it('prints code, message and every field with its rule, and nothing else of the request', () => {
    const text = formatApiError('Creating variable 0', 400, {
      code: 'VALIDATION_ERROR',
      message: 'Check the highlighted fields.',
      details: {
        fields: [
          { field: 'name', rule: 'pattern', message: 'must match pattern' },
          { field: 'environments[0].environment', rule: 'enum', message: 'must be DEV or PROD' },
        ],
      },
    });
    assert.equal(
      text,
      [
        'Creating variable 0: the API answered 400 VALIDATION_ERROR: Check the highlighted fields.',
        '  - name [pattern]: must match pattern',
        '  - environments[0].environment [enum]: must be DEV or PROD',
      ].join('\n'),
    );
  });

  it('prints the other details of an error (for example the missing element) and copes with no body', () => {
    assert.match(
      formatApiError('Reading', 404, { code: 'NOT_FOUND', message: 'Gone', details: { element: 'screen', id: 7 } }),
      /404 NOT_FOUND: Gone\n {2}details: \{"element":"screen","id":7\}$/,
    );
    assert.equal(formatApiError('Reading', 502, undefined), 'Reading: the API answered 502');
  });
});
