/**
 * Test data of the Bruno sandbox for what the API cannot create yet (screens, links, assignments): the application
 * "Sandbox Fixtures". It reuses the fixtures of the tests (tests/helpers/fixtures.ts) and writes as docs_owner, so it
 * refuses to run on any database other than the exact name `docs_sandbox`. What it contains and why is described in
 * bruno/docs-system-api/README.md.
 *
 * @module scripts/lib/sandboxFixtures
 */
import pg from 'pg';
import {
  insertApplication,
  insertCollection,
  insertScreen,
  insertScreenVariable,
  insertVariable,
  insertVariableCollection,
} from '../../tests/helpers/fixtures.js';

/** The only database these scripts create, drop or fill. */
export const SANDBOX_DB = 'docs_sandbox';

/** Names of the fixed data; the collection requests look them up by id, never by name. */
export const FIXTURE_NAMES = {
  application: 'Sandbox Fixtures',
  screenA: 'Sandbox Screen A',
  screenB: 'Sandbox Screen B',
  sharedVariable: 'gSandboxShared',
  linkedVariable: 'gSandboxLinked',
  collection: 'colSandbox',
} as const;

/** Ids of the fixed data, written to the collection's `.env` as `SANDBOX_FIXTURES_*`. */
export type SandboxFixtureIds = {
  applicationId: number;
  screenAId: number;
  screenBId: number;
  sharedVariableId: number;
  linkedVariableId: number;
  collectionId: number;
};

/**
 * Throws unless `url` points at exactly `docs_sandbox`.
 *
 * @param url - A PostgreSQL connection URL.
 */
export function assertSandboxUrl(url: string): void {
  let database: string;
  try {
    database = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  } catch {
    throw new Error(`Refusing to insert fixtures: the connection URL is not valid (expected a ${SANDBOX_DB} URL)`);
  }
  if (database !== SANDBOX_DB) {
    throw new Error(`Refusing to insert fixtures into database "${database}": only ${SANDBOX_DB} is allowed`);
  }
}

/**
 * Inserts "Sandbox Fixtures": two screens besides App (OnStart); `gSandboxShared` (GLOBAL, origin A, READ from B, SET
 * assignment in `colSandbox`, to try SCOPE_CONFLICT and the dependencies) and `gSandboxLinked` (GLOBAL, origin A, READ
 * from B, no assignments, to try CONTEXT_SCREEN_MISMATCH).
 *
 * @param ownerUrl - docs_owner connection URL of `docs_sandbox`.
 * @param adminEmail - E-mail of the administrator that authors the data.
 * @returns The ids the collection's requests need.
 */
export async function insertSandboxFixtures(ownerUrl: string, adminEmail: string): Promise<SandboxFixtureIds> {
  assertSandboxUrl(ownerUrl);
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  try {
    const current = await owner.query<{ db: string }>('SELECT current_database() AS db');
    if (current.rows[0]?.db !== SANDBOX_DB) throw new Error(`Connected to the wrong database; expected ${SANDBOX_DB}`);
    const admin = await owner.query<{ id: number }>('SELECT id FROM app_user WHERE email = $1', [adminEmail]);
    if (!admin.rows[0]) throw new Error('The sandbox administrator does not exist (run the seed first)');
    const t = { owner, users: { admin: { id: admin.rows[0].id } } };

    const app = await insertApplication(t, { name: FIXTURE_NAMES.application });
    const screenA = await insertScreen(t, app.id, { name: FIXTURE_NAMES.screenA });
    const screenB = await insertScreen(t, app.id, { name: FIXTURE_NAMES.screenB });
    const environments = [{ environment: 'DEV' as const }, { environment: 'PROD' as const }];
    const shared = await insertVariable(t, app.id, {
      name: FIXTURE_NAMES.sharedVariable,
      originScreenId: screenA.id,
      environments,
    });
    const linked = await insertVariable(t, app.id, {
      name: FIXTURE_NAMES.linkedVariable,
      originScreenId: screenA.id,
      environments,
    });
    const collection = await insertCollection(t, app.id, { name: FIXTURE_NAMES.collection });
    for (const variable of [shared, linked]) {
      await insertScreenVariable(t, {
        screenId: screenB.id,
        variableId: variable.id,
        accessMode: 'READ',
        usedIn: 'Label',
      });
    }
    await insertVariableCollection(t, {
      variableId: shared.id,
      collectionId: collection.id,
      screenId: screenA.id,
      usedIn: 'OnVisible',
      assignmentFunction: 'SET',
    });
    return {
      applicationId: app.id,
      screenAId: screenA.id,
      screenBId: screenB.id,
      sharedVariableId: shared.id,
      linkedVariableId: linked.id,
      collectionId: collection.id,
    };
  } finally {
    await owner.end();
  }
}
