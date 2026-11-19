/**
 * Fixtures for data the API cannot create yet (screens, collections, components, links, dependencies, Jira tickets,
 * comments), inserted as docs_owner on the disposable database of `startTestApp`. Reusable by every module's tests.
 *
 * Each helper runs in its own transaction, so the deferred constraint triggers (subtype, environment, context
 * screen) are judged at its COMMIT, like in the API. Inserts by the owner are audited with a NULL actor.
 */
import type pg from 'pg';

/**
 * What the fixtures need: a docs_owner connection and the user that authors what they insert. `TestApp` fits, and so
 * does the sandbox tooling (scripts/lib/sandboxFixtures.ts), which has no application.
 */
export type FixtureContext = { owner: Pick<pg.Client, 'query'>; users: { admin: { id: number } } };

type Environment = 'DEV' | 'PROD';

let counter = 0;
const next = (): number => (counter += 1);

/** Runs `fn` in a transaction on the owner connection. */
async function transaction<T>(t: FixtureContext, fn: () => Promise<T>): Promise<T> {
  await t.owner.query('BEGIN');
  try {
    const result = await fn();
    await t.owner.query('COMMIT');
    return result;
  } catch (error) {
    await t.owner.query('ROLLBACK');
    throw error;
  }
}

/** Inserts the supertype row of an element and returns its id. */
async function insertElement(t: FixtureContext, type: string, applicationId: number): Promise<number> {
  const r = await t.owner.query<{ id: number }>(
    `INSERT INTO documented_element (type, application_id) VALUES ($1::element_type, $2) RETURNING id`,
    [type, applicationId],
  );
  return r.rows[0]!.id;
}

/** Inserts the environments of a variable or collection. */
async function insertEnvironments(
  t: FixtureContext,
  id: number,
  type: 'VARIABLE' | 'COLLECTION',
  environments: readonly { environment: Environment; notes?: string | null }[],
): Promise<void> {
  for (const e of environments) {
    await t.owner.query(
      `INSERT INTO element_environment (element_id, element_type, environment, notes) VALUES ($1, $2::element_type, $3::environment, $4)`,
      [id, type, e.environment, e.notes ?? null],
    );
  }
}

/** Creates an extra application (with its App (OnStart) screen, made by the trigger) as `createdBy`. */
export async function insertApplication(
  t: FixtureContext,
  over: { name?: string; createdBy?: number; status?: 'ACTIVE' | 'ARCHIVED' } = {},
): Promise<{ id: number; name: string; appContextScreenId: number }> {
  const name = over.name ?? `Fixture app ${next()}`;
  const r = await t.owner.query<{ id: number }>(
    `INSERT INTO application (name, platform, created_by, status) VALUES ($1, 'Power Apps', $2, $3::application_status) RETURNING id`,
    [name, over.createdBy ?? t.users.admin.id, over.status ?? 'ACTIVE'],
  );
  const screen = await t.owner.query<{ id: number }>(
    `SELECT id FROM screen WHERE application_id = $1 AND is_app_context`,
    [r.rows[0]!.id],
  );
  return { id: r.rows[0]!.id, name, appContextScreenId: screen.rows[0]!.id };
}

/** Archives or reactivates an application directly in the database. */
export async function setApplicationStatus(
  t: FixtureContext,
  applicationId: number,
  status: 'ACTIVE' | 'ARCHIVED',
): Promise<void> {
  await t.owner.query(`UPDATE application SET status = $2::application_status WHERE id = $1`, [applicationId, status]);
}

/** Inserts a screen (not App (OnStart)) and returns its id. */
export async function insertScreen(
  t: FixtureContext,
  applicationId: number,
  over: {
    name?: string;
    authorId?: number;
    documentationStatus?: 'UNDOCUMENTED' | 'DRAFT' | 'IN_PROGRESS' | 'IN_REVIEW' | 'APPROVED';
  } = {},
): Promise<{ id: number; name: string }> {
  const name = over.name ?? `Screen ${next()}`;
  const id = await transaction(t, async () => {
    const elementId = await insertElement(t, 'SCREEN', applicationId);
    await t.owner.query(
      `INSERT INTO screen (id, application_id, name, author_id, documentation_status)
       VALUES ($1, $2, $3, $4, $5::documentation_status)`,
      [elementId, applicationId, name, over.authorId ?? t.users.admin.id, over.documentationStatus ?? 'UNDOCUMENTED'],
    );
    return elementId;
  });
  return { id, name };
}

/** Deletes a screen directly in the database (the variables that originate in it keep existing, without origin). */
export async function deleteScreen(t: FixtureContext, screenId: number): Promise<void> {
  await t.owner.query(`DELETE FROM screen WHERE id = $1`, [screenId]);
}

/** Inserts a variable with its environments (default DEV) and returns its id. */
export async function insertVariable(
  t: FixtureContext,
  applicationId: number,
  over: {
    name?: string;
    scope?: 'GLOBAL' | 'CONTEXT';
    dataType?: string;
    description?: string | null;
    originScreenId?: number | null;
    originUsedIn?: string | null;
    environments?: readonly { environment: Environment; notes?: string | null }[];
  } = {},
): Promise<{ id: number; name: string }> {
  const name = over.name ?? `gFixture${next()}`;
  const id = await transaction(t, async () => {
    const elementId = await insertElement(t, 'VARIABLE', applicationId);
    await t.owner.query(
      `INSERT INTO variable (id, application_id, name, data_type, scope, description, origin_screen_id, origin_used_in)
       VALUES ($1, $2, $3, $4::data_type, $5::variable_scope, $6, $7, $8)`,
      [
        elementId,
        applicationId,
        name,
        over.dataType ?? 'TEXT',
        over.scope ?? 'GLOBAL',
        over.description ?? null,
        over.originScreenId ?? null,
        over.originUsedIn ?? null,
      ],
    );
    await insertEnvironments(t, elementId, 'VARIABLE', over.environments ?? [{ environment: 'DEV' }]);
    return elementId;
  });
  return { id, name };
}

/** Inserts a collection with its environments (default DEV) and returns its id. */
export async function insertCollection(
  t: FixtureContext,
  applicationId: number,
  over: { name?: string; environments?: readonly { environment: Environment; notes?: string | null }[] } = {},
): Promise<{ id: number; name: string }> {
  const name = over.name ?? `colFixture${next()}`;
  const id = await transaction(t, async () => {
    const elementId = await insertElement(t, 'COLLECTION', applicationId);
    await t.owner.query(`INSERT INTO collection (id, application_id, name) VALUES ($1, $2, $3)`, [
      elementId,
      applicationId,
      name,
    ]);
    await insertEnvironments(t, elementId, 'COLLECTION', over.environments ?? [{ environment: 'DEV' }]);
    return elementId;
  });
  return { id, name };
}

/** Inserts a component of a screen and returns its id. */
export async function insertComponent(
  t: FixtureContext,
  applicationId: number,
  screenId: number,
  over: { name?: string; type?: string } = {},
): Promise<{ id: number; name: string }> {
  const name = over.name ?? `cmpFixture${next()}`;
  const id = await transaction(t, async () => {
    const elementId = await insertElement(t, 'COMPONENT', applicationId);
    await t.owner.query(
      `INSERT INTO component (id, application_id, screen_id, name, type) VALUES ($1, $2, $3, $4, $5)`,
      [elementId, applicationId, screenId, name, over.type ?? 'Button'],
    );
    return elementId;
  });
  return { id, name };
}

/** Links a screen to a variable (`screen_variable`) and returns the row id. */
export async function insertScreenVariable(
  t: FixtureContext,
  link: { screenId: number; variableId: number; accessMode: 'READ' | 'WRITE' | 'READ_WRITE'; usedIn: string },
): Promise<number> {
  const r = await t.owner.query<{ id: number }>(
    `INSERT INTO screen_variable (screen_id, variable_id, access_mode, used_in)
     VALUES ($1, $2, $3::access_mode, $4) RETURNING id`,
    [link.screenId, link.variableId, link.accessMode, link.usedIn],
  );
  return r.rows[0]!.id;
}

/** Links a screen to a collection (`screen_collection`) and returns the row id. */
export async function insertScreenCollection(
  t: FixtureContext,
  link: { screenId: number; collectionId: number; accessMode: 'READ' | 'WRITE' | 'READ_WRITE'; usedIn: string },
): Promise<number> {
  const r = await t.owner.query<{ id: number }>(
    `INSERT INTO screen_collection (screen_id, collection_id, access_mode, used_in)
     VALUES ($1, $2, $3::access_mode, $4) RETURNING id`,
    [link.screenId, link.collectionId, link.accessMode, link.usedIn],
  );
  return r.rows[0]!.id;
}

/** Assigns a variable from a collection (`variable_collection`) and returns the row id. */
export async function insertVariableCollection(
  t: FixtureContext,
  link: {
    variableId: number;
    collectionId: number;
    screenId: number;
    usedIn: string;
    assignmentFunction: 'SET' | 'UPDATE_CONTEXT';
    tableFunction?: string | null;
  },
): Promise<number> {
  const r = await t.owner.query<{ id: number }>(
    `INSERT INTO variable_collection (variable_id, variable_scope, collection_id, screen_id, assignment_function, table_function, used_in)
     VALUES ($1, (SELECT scope FROM variable WHERE id = $1), $2, $3, $4::assignment_function, $5, $6) RETURNING id`,
    [
      link.variableId,
      link.collectionId,
      link.screenId,
      link.assignmentFunction,
      link.tableFunction ?? null,
      link.usedIn,
    ],
  );
  return r.rows[0]!.id;
}

/** Inserts a dependency between two elements; the types are read from `documented_element`. */
export async function insertDependency(
  t: FixtureContext,
  dependency: {
    sourceId: number;
    targetId: number;
    relationType: 'USES' | 'DERIVES_FROM' | 'NAVIGATES_TO';
    description?: string | null;
  },
): Promise<number> {
  const r = await t.owner.query<{ id: number }>(
    `INSERT INTO dependency (source_id, source_type, target_id, target_type, relation_type, description)
     VALUES ($1, (SELECT type FROM documented_element WHERE id = $1),
             $2, (SELECT type FROM documented_element WHERE id = $2), $3::relation_type, $4) RETURNING id`,
    [dependency.sourceId, dependency.targetId, dependency.relationType, dependency.description ?? null],
  );
  return r.rows[0]!.id;
}

/**
 * Inserts a Jira chain Epic -> Story -> Subtasks on a screen, one Subtask per status category given.
 *
 * @returns The ids of the Subtask rows, in the order given.
 */
export async function insertSubtasks(
  t: FixtureContext,
  screenId: number,
  categories: readonly ('TO_DO' | 'IN_PROGRESS' | 'DONE')[],
): Promise<number[]> {
  const ticket = async (
    level: 'EPIC' | 'STANDARD' | 'SUBTASK',
    parent: { id: number; level: 'EPIC' | 'STANDARD' } | null,
    category: string,
  ): Promise<number> => {
    const n = next();
    const r = await t.owner.query<{ id: number }>(
      `INSERT INTO jira_ticket (screen_id, jira_issue_id, jira_issue_key, hierarchy_level, issue_type,
                                parent_ticket_id, parent_level, summary, status, status_category, created_by)
       VALUES ($1, $2, $3, $4::jira_hierarchy_level, 'Issue', $5, $6::jira_hierarchy_level, 'Fixture', 'Status',
               $7::jira_status_category, $8) RETURNING id`,
      [screenId, `9${n}`, `TECHEA-${n}`, level, parent?.id ?? null, parent?.level ?? null, category, t.users.admin.id],
    );
    return r.rows[0]!.id;
  };
  const epic = await ticket('EPIC', null, 'TO_DO');
  const story = await ticket('STANDARD', { id: epic, level: 'EPIC' }, 'TO_DO');
  const ids: number[] = [];
  for (const category of categories) ids.push(await ticket('SUBTASK', { id: story, level: 'STANDARD' }, category));
  return ids;
}

/** Inserts `count` comments on a screen (every row of `comment` counts, review decisions included). */
export async function insertComments(
  t: FixtureContext & { users: { developer: { id: number } } },
  screenId: number,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await t.owner.query(
      `INSERT INTO comment (screen_id, user_id, text, review_decision)
       VALUES ($1, $2, 'Fixture comment', $3::review_decision)`,
      [screenId, t.users.developer.id, i === 0 && count > 1 ? 'RETURN' : null],
    );
  }
}
