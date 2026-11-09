/**
 * `npm run sandbox:graph` along the same path as the real run, on a disposable database: the very function the script
 * calls (`runSandboxGraphCli`), its real client (`fetch`, JSON, login) talking HTTP to a real server that mounts the API
 * with the contract validator exactly as `npm run sandbox:api` does, and a database with what `npm run sandbox:db`
 * leaves: the seeded administrator and reserved account and the "Sandbox Fixtures" application (so the new application
 * gets id 2). Only the address changes: the client keeps its fixed sandbox URL and the test routes it to the server.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/index.js';
import { loadSeedConfig } from '../../src/config/seed.js';
import { createPrisma, type Database } from '../../src/db/prisma.js';
import { runSeed } from '../../src/db/seed.js';
import { createLogger } from '../../src/http/logger.js';
import {
  generatePassword,
  SANDBOX_ADMIN_EMAIL,
  SANDBOX_ADMIN_NAME,
  SANDBOX_RESERVED_EMAIL,
} from '../../scripts/lib/sandbox.js';
import { insertFixtureRows } from '../../scripts/lib/sandboxFixtures.js';
import { runSandboxGraphCli, SANDBOX_GRAPH_BASE_URL } from '../../scripts/lib/sandboxGraph.js';
import { testEnv } from '../helpers/app.js';
import { createTestDb, type TestDb } from '../helpers/testDb.js';

describe('sandbox:graph, the real path', () => {
  let testDb: TestDb | undefined;
  let owner: pg.Client | undefined;
  let db: Database | undefined;
  let server: Server | undefined;
  let dir: string | undefined;
  let envFile = '';
  let routedFetch: typeof fetch = fetch;

  before(async () => {
    try {
      testDb = await createTestDb();
      owner = new pg.Client({ connectionString: testDb.ownerUrl });
      await owner.connect();
      db = createPrisma(testDb.appUrl);

      // The API as `sandbox:api` configures it (development mode, the reserved account of the sandbox).
      const env = testEnv(testDb.appUrl, {
        NODE_ENV: 'development',
        LOG_LEVEL: 'warn',
        TRUST_PROXY: 'false',
        JWT_ACCESS_TTL_SECONDS: '28800',
        SESSION_MAX_SECONDS: '43200',
        INTEGRATION_USER_EMAIL: SANDBOX_RESERVED_EMAIL,
      });
      const config = loadConfig(env);
      const built = buildApp({ config, db, logger: createLogger(config, { write: () => undefined }) });

      // What `npm run sandbox:db` leaves behind: the seed, then the fixtures, then the credentials file.
      const password = generatePassword();
      await runSeed(
        db,
        loadSeedConfig({
          ...env,
          SEED_ADMIN_NAME: SANDBOX_ADMIN_NAME,
          SEED_ADMIN_EMAIL: SANDBOX_ADMIN_EMAIL,
          SEED_ADMIN_PASSWORD: password,
        }),
      );
      await insertFixtureRows(owner, SANDBOX_ADMIN_EMAIL);
      dir = mkdtempSync(join(tmpdir(), 'sandbox-graph-load-'));
      envFile = join(dir, '.env');
      writeFileSync(envFile, `SANDBOX_ADMIN_EMAIL=${SANDBOX_ADMIN_EMAIL}\nSANDBOX_ADMIN_PASSWORD=${password}\n`);

      // A real HTTP server; the client keeps its fixed sandbox URL and the test only routes it here.
      const listening = createServer(built.app);
      server = listening;
      await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve));
      const port = (listening.address() as AddressInfo).port;
      routedFetch = (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        return fetch(url.replace(SANDBOX_GRAPH_BASE_URL, `http://127.0.0.1:${port}/api/v1`), init);
      };
    } catch (error) {
      await release();
      throw error;
    }
  });
  after(release);

  /** Closes everything that was opened, whatever failed. */
  async function release(): Promise<void> {
    const failures: unknown[] = [];
    const attempt = async (step: () => unknown): Promise<void> => {
      try {
        await step();
      } catch (error) {
        failures.push(error);
      }
    };
    await attempt(() => server?.closeAllConnections());
    await attempt(
      () => server && new Promise<void>((resolve, reject) => server!.close((e) => (e ? reject(e) : resolve()))),
    );
    await attempt(() => db?.base.$disconnect());
    await attempt(() => owner?.end());
    await attempt(() => dir && rmSync(dir, { recursive: true, force: true }));
    await attempt(() => testDb?.drop());
    server = undefined;
    db = undefined;
    owner = undefined;
    dir = undefined;
    testDb = undefined;
    if (failures.length > 0) throw failures[0];
  }

  /** Runs the command as the script does (no arguments) and collects what it prints. */
  async function runCommand(randomPrefix?: () => string, argv: string[] = []) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runSandboxGraphCli(argv, {
      envFile,
      fetchImpl: routedFetch,
      ...(randomPrefix ? { randomPrefix } : {}),
      log: (line) => out.push(line),
      error: (line) => err.push(line),
    });
    return { code, out, err };
  }

  it('the first run, with the default random prefix, loads 500 nodes into application 2', async () => {
    const run = await runCommand();
    assert.deepEqual(run.err, []);
    assert.equal(run.code, 0);
    assert.ok(
      run.out.some((line) => /^Application "Graph demo g[0-9a-f]{6}" \(id 2\)$/.test(line)),
      run.out.join('\n'),
    );
    assert.ok(run.out.includes('Nodes: SCREEN=40, VARIABLE=120, COLLECTION=60, COMPONENT=280'));
    assert.ok(run.out.includes('The graph matches the plan: yes'));
    assert.ok(run.out.some((line) => /^Edges: .*ACCESSES=312/.test(line)));
    console.log(`[sandbox:graph] ${run.out.find((line) => line.startsWith('GET /dependencies/graph took'))}`);
  });

  it('a second run, with another prefix, creates its own application and does not collide', async () => {
    const run = await runCommand(undefined, ['--prefix', 'ab12cd']);
    assert.deepEqual(run.err, []);
    assert.equal(run.code, 0);
    assert.ok(run.out.includes('Application "Graph demo ab12cd" (id 3)'), run.out.join('\n'));
  });

  it('prints the code, message and details of an error of the API, and never the credentials', async () => {
    // The same prefix again: the application name is taken, so the API answers 409 DUPLICATE_NAME.
    const run = await runCommand(undefined, ['--prefix', 'ab12cd']);
    assert.equal(run.code, 1);
    const text = run.err.join('\n');
    assert.match(text, /Creating the application: the API answered 409 DUPLICATE_NAME: /);
    assert.match(text, /details: \{.*"name":"Graph demo ab12cd".*\}/);
    const password = readFileSync(envFile, 'utf8').split('SANDBOX_ADMIN_PASSWORD=')[1]!.trim();
    assert.ok(!text.includes(password) && !run.out.join('\n').includes(password));
    assert.ok(!/bearer|authorization/i.test(text));
  });
});
