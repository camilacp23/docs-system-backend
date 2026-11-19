/**
 * Translation of database errors (SDD 7.1 note, D-62 to D-65): the catalog is complete, every row of the table has
 * an expected outcome, and the classes of error are provoked on a real database and checked end to end through the
 * real errorHandler.
 */
import '../helpers/env.js';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import supertest from 'supertest';
import { DEFAULT_OPENAPI_PATH } from '../../src/app.js';
import { auditContext } from '../../src/db/prisma.js';
import { extractDbFacts, translateDbError, type DbFacts } from '../../src/http/dbErrors.js';
import { CONSTRAINT_RULES } from '../../src/http/dbRules.js';
import { createErrorHandler } from '../../src/http/errorHandler.js';
import { requestContext } from '../../src/http/requestContext.js';
import { loadPolicies } from '../../src/security/rbac.js';
import { startTestApp, type TestApp } from '../helpers/app.js';

/* -------------------------------------------------------------------------------------------------------------
 * 1. The table: every constraint of the migrations has a rule, and every rule has its expected outcome.
 * ----------------------------------------------------------------------------------------------------------- */

const DUPLICATE_NAME = [
  'application_name_key',
  'screen_application_id_name_key',
  'variable_global_name_key',
  'variable_context_name_key',
  'collection_application_id_name_key',
];
const UNIQUE_VALIDATION = [
  'component_screen_id_name_key',
  'collection_field_collection_id_name_key',
  'screen_variable_screen_id_variable_id_used_in_key',
  'screen_collection_screen_id_collection_id_used_in_key',
  'variable_collection_unique_key',
  'dependency_source_target_relation_key',
  'element_environment_pkey',
];
const CHECK_VALIDATION = [
  'app_user_email_lowercase_chk',
  'app_user_email_format_chk',
  'app_user_name_not_blank_chk',
  'application_name_not_blank_chk',
  'application_jira_key_format_chk',
  'screen_name_not_blank_chk',
  'screen_miro_link_https_chk',
  'variable_name_not_blank_chk',
  'variable_origin_used_in_chk',
  'collection_name_not_blank_chk',
  'component_name_not_blank_chk',
  'component_type_not_blank_chk',
  'collection_field_name_not_blank_chk',
  'collection_field_position_chk',
  'screen_variable_used_in_not_blank_chk',
  'screen_variable_origin_is_write_chk',
  'screen_collection_used_in_not_blank_chk',
  'variable_collection_used_in_not_blank_chk',
  'comment_text_not_blank_chk',
];
const NOT_FOUND = [
  'documented_element_application_id_fkey',
  'report_application_id_fkey',
  'variable_origin_screen_id_fkey',
  'component_screen_id_fkey',
  'screen_variable_screen_id_fkey',
  'screen_collection_screen_id_fkey',
  'variable_collection_screen_id_fkey',
  'jira_ticket_screen_id_fkey',
  'comment_screen_id_fkey',
  'screen_variable_variable_id_fkey',
  'variable_collection_variable_id_variable_scope_fkey',
  'collection_field_collection_id_fkey',
  'screen_collection_collection_id_fkey',
  'variable_collection_collection_id_fkey',
  'report_file_report_id_fkey',
  'onboarding_progress_application_id_fkey',
  'dependency_source_id_source_type_fkey',
  'dependency_target_id_target_type_fkey',
];
const OTHER_CODES: Record<string, string> = {
  app_user_email_key: 'EMAIL_TAKEN',
  variable_collection_function_scope_chk: 'SCOPE_MISMATCH',
  report_published_ready_chk: 'REPORT_NOT_READY',
  jira_ticket_parent_ticket_id_screen_id_parent_level_fkey: 'STORY_NOT_IN_SCREEN',
};
/** Defects or errors nobody can fix from the client: 500 INTERNAL_ERROR, logged. */
const INTERNAL = [
  'jira_ticket_jira_issue_id_key',
  'jira_ticket_jira_issue_key_key',
  'jira_ticket_one_epic_per_screen',
  'refresh_token_token_hash_key',
  'one_app_context_per_application',
  'documented_element_id_type_key',
  'documented_element_id_type_app_key',
  'screen_id_element_type_application_id_key',
  'variable_id_element_type_application_id_key',
  'variable_id_scope_key',
  'collection_id_element_type_application_id_key',
  'component_id_element_type_application_id_key',
  'jira_ticket_id_screen_level_key',
  'report_ready_has_file_chk',
  'dependency_no_self_chk',
  'dependency_allowed_pairs_chk',
  'jira_ticket_key_format_chk',
  'jira_ticket_hierarchy_chk',
  'refresh_token_expiry_chk',
  'screen_element_type_chk',
  'variable_element_type_chk',
  'collection_element_type_chk',
  'component_element_type_chk',
  'element_environment_type_chk',
  'audit_log_action_chk',
  'audit_log_event_name_chk',
  'audit_log_entity_type_chk',
  'onboarding_progress_step_chk',
  'onboarding_progress_user_id_fkey',
  'refresh_token_user_id_fkey',
  'application_created_by_fkey',
  'screen_author_id_fkey',
  'jira_ticket_created_by_fkey',
  'comment_user_id_fkey',
  'report_generated_by_fkey',
  'audit_log_actor_user_id_fkey',
  'screen_id_element_type_application_id_fkey',
  'variable_id_element_type_application_id_fkey',
  'collection_id_element_type_application_id_fkey',
  'component_id_element_type_application_id_fkey',
  'element_environment_element_id_element_type_fkey',
  ...[
    'app_user',
    'refresh_token',
    'application',
    'documented_element',
    'screen',
    'variable',
    'collection',
    'collection_field',
    'component',
    'screen_variable',
    'screen_collection',
    'variable_collection',
    'dependency',
    'jira_ticket',
    'comment',
    'report',
    'report_file',
    'audit_log',
    'onboarding_progress',
  ].map((t) => `${t}_pkey`),
];

const EXPECTED_BY_NAME = new Map<string, string>([
  ...DUPLICATE_NAME.map((n): [string, string] => [n, 'DUPLICATE_NAME']),
  ...UNIQUE_VALIDATION.map((n): [string, string] => [n, 'VALIDATION_ERROR']),
  ...CHECK_VALIDATION.map((n): [string, string] => [n, 'VALIDATION_ERROR']),
  ...NOT_FOUND.map((n): [string, string] => [n, 'NOT_FOUND']),
  ...INTERNAL.map((n): [string, string] => [n, 'INTERNAL_ERROR']),
  ...Object.entries(OTHER_CODES),
]);

describe('database error table', () => {
  let t: TestApp;
  before(async () => {
    t = await startTestApp({ reportServerErrors: false }); // it causes database errors on purpose
  });
  after(async () => {
    await t.close();
  });

  it('has a rule for every constraint and unique index of the migrations, and no rule for a missing one', async () => {
    const r = await t.owner.query<{ name: string }>(`
      SELECT conname AS name FROM pg_constraint
       WHERE contype IN ('p', 'u', 'c', 'f') AND connamespace = 'public'::regnamespace
      UNION
      SELECT i.relname FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
       WHERE x.indisunique AND i.relnamespace = 'public'::regnamespace`);
    const inDatabase = new Set(r.rows.map((row) => row.name).filter((n) => !n.startsWith('_prisma_')));
    const missing = [...inDatabase].filter((n) => !(n in CONSTRAINT_RULES));
    assert.deepEqual(missing, [], 'constraints without an entry in src/http/dbRules.ts');
    const stale = Object.keys(CONSTRAINT_RULES).filter((n) => !inDatabase.has(n) && n !== 'context_screen_mismatch');
    assert.deepEqual(stale, [], 'rules for constraints that do not exist');
  });

  it('every rule has an expected outcome in this test, and the outcome is the expected one', async () => {
    const names = Object.keys(CONSTRAINT_RULES).filter((n) => n !== 'context_screen_mismatch');
    assert.deepEqual(
      names.filter((n) => !EXPECTED_BY_NAME.has(n)),
      [],
      'rules without an expectation',
    );
    assert.deepEqual(
      [...EXPECTED_BY_NAME.keys()].filter((n) => !names.includes(n)),
      [],
      'expectations without a rule',
    );

    const appRow = await t.owner.query<{ id: number }>(
      `INSERT INTO application (name, platform, created_by) VALUES ('SAR', 'Power Apps', $1) RETURNING id`,
      [t.users.admin.id],
    );
    const applicationId = appRow.rows[0]!.id;
    const screenRow = await t.owner.query<{ id: number }>(`SELECT id FROM screen WHERE application_id = $1`, [
      applicationId,
    ]);
    const originScreenId = screenRow.rows[0]!.id;
    const req = {
      body: { name: 'Same name', applicationId, originScreenId, storyId: 7 },
      policy: { operationId: 'createScreen', path: '/screens' },
    };
    for (const [name, expected] of EXPECTED_BY_NAME) {
      const facts: DbFacts = { sqlstate: '23000', constraint: name };
      const outcome = await translateDbError(facts, {
        req: req as never,
        res: { locals: {} },
        db: t.db,
      });
      const got = outcome.kind === 'internal' ? 'INTERNAL_ERROR' : outcome.error.code;
      assert.equal(got, expected, name);
      if (outcome.kind === 'api') {
        assert.equal(outcome.error.status, { VALIDATION_ERROR: 400, NOT_FOUND: 404 }[got] ?? outcome.error.status);
      }
    }
  });

  it('dependency_no_self_chk is translated per operation: collections give 400, every other operation stays 500', async () => {
    const facts: DbFacts = { sqlstate: '23514', constraint: 'dependency_no_self_chk' };
    const outcomeOf = (operationId: string, body: object, id?: number) =>
      translateDbError(facts, {
        req: { body, policy: { operationId, path: '/x' } } as never,
        res: { locals: { pathParams: id === undefined ? {} : { id: String(id) } } },
        db: t.db,
      });
    for (const operationId of ['updateCollection', 'createCollection', 'createVariable']) {
      const outcome = await outcomeOf(
        operationId,
        { derivedFrom: [5, 7] },
        operationId === 'createCollection' ? undefined : 7,
      );
      if (operationId.endsWith('Collection')) {
        assert.equal(outcome.kind, 'api', operationId);
        if (outcome.kind === 'api') {
          assert.equal(outcome.error.status, 400);
          assert.deepEqual((outcome.error.details as { fields: unknown[] }).fields, [
            {
              field: operationId === 'updateCollection' ? 'derivedFrom[1]' : 'derivedFrom[]',
              rule: 'self',
              message: 'A collection cannot derive from itself.',
            },
          ]);
        }
      } else {
        assert.equal(outcome.kind, 'internal', operationId);
      }
    }
  });

  it('dependency_no_self_chk on updateScreen is 400 at navigations[i].targetScreenId (D-84)', async () => {
    const outcome = await translateDbError(
      { sqlstate: '23514', constraint: 'dependency_no_self_chk' },
      {
        req: {
          body: { navigations: [{ targetScreenId: 3 }, { targetScreenId: 7 }] },
          policy: { operationId: 'updateScreen', path: '/x' },
        } as never,
        res: { locals: { pathParams: { id: '7' } } },
        db: t.db,
      },
    );
    assert.equal(outcome.kind, 'api');
    if (outcome.kind === 'api') {
      assert.equal(outcome.error.status, 400);
      assert.deepEqual((outcome.error.details as { fields: unknown[] }).fields, [
        { field: 'navigations[1].targetScreenId', rule: 'self', message: 'A screen cannot navigate to itself.' },
      ]);
    }
  });

  it('a constraint that is not in the table is 500, never guessed', async () => {
    const outcome = await translateDbError(
      { sqlstate: '23505', constraint: 'brand_new_unique_idx' },
      { req: { body: {} } as never, res: { locals: {} }, db: t.db },
    );
    assert.equal(outcome.kind, 'internal');
  });

  it('extracts the facts from the three shapes the stack produces', () => {
    const cause = {
      originalCode: '23505',
      originalMessage: 'llave duplicada viola restricción de unicidad «app_user_email_key»',
      kind: 'UniqueConstraintViolation',
      constraint: { index: 'app_user_email_key' },
      table: 'app_user',
    };
    const wrapped = {
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
      meta: { modelName: 'User', driverAdapterError: { name: 'DriverAdapterError', cause } },
    };
    assert.deepEqual(extractDbFacts(wrapped), {
      prismaCode: 'P2002',
      modelName: 'User',
      sqlstate: '23505',
      message: cause.originalMessage,
      constraint: 'app_user_email_key',
      table: 'app_user',
    });
    // deferred trigger at COMMIT: a bare DriverAdapterError, no constraint name, localized message
    const bare = {
      name: 'DriverAdapterError',
      cause: {
        originalCode: '23514',
        originalMessage:
          'el nuevo registro para la relación «app_user» viola la restricción «check» «app_user_name_not_blank_chk»',
        kind: 'postgres',
      },
    };
    const f = extractDbFacts(bare);
    assert.equal(f?.sqlstate, '23514');
    assert.equal(f?.constraint, 'app_user_name_not_blank_chk', 'found by name in the localized message');
    // a raw `pg` error
    const raw = { code: '23503', severity: 'ERROR', constraint: 'comment_screen_id_fkey', message: 'x' };
    assert.equal(extractDbFacts(raw)?.constraint, 'comment_screen_id_fkey');
    assert.equal(extractDbFacts(new Error('plain')), null);
    assert.equal(extractDbFacts({ name: 'PrismaClientValidationError' }), null);
  });
});

/* -------------------------------------------------------------------------------------------------------------
 * 2. Provoked on a real database, through the real errorHandler.
 * ----------------------------------------------------------------------------------------------------------- */

type Expect = {
  status: number;
  code: string;
  message?: string;
  details?: unknown;
  /** For 500: the reason that must be in the log (never in the response). */
  logReason?: string | RegExp;
};
type Scenario = {
  name: string;
  op: string;
  body?: Record<string, unknown>;
  pathId?: number;
  run: () => Promise<unknown>;
  expect: Expect;
};

describe('database errors provoked on a real database', () => {
  let t: TestApp;
  const ids = {} as Record<string, number>;
  let scenarios: Scenario[] = [];
  let http: ReturnType<typeof supertest>;

  const policies = loadPolicies(DEFAULT_OPENAPI_PATH);
  const sql =
    (text: string, ...params: unknown[]) =>
    () =>
      t.db.auditedTransaction((tx) => tx.$executeRawUnsafe(text, ...params));
  const q = async (text: string, params: unknown[] = []): Promise<number> =>
    (await t.owner.query<{ id: number }>(text, params)).rows[0]!.id;

  const newScreen = (appId: number, name: string) =>
    q(
      `WITH e AS (INSERT INTO documented_element (type, application_id) VALUES ('SCREEN', $1) RETURNING id)
       INSERT INTO screen (id, application_id, name, author_id) SELECT id, $1, $2, $3 FROM e RETURNING id`,
      [appId, name, t.users.admin.id],
    );
  const newVariable = async (appId: number, name: string, scope: 'GLOBAL' | 'CONTEXT', origin: number | null) => {
    await t.owner.query('BEGIN');
    const id = await q(
      `WITH e AS (INSERT INTO documented_element (type, application_id) VALUES ('VARIABLE', $1) RETURNING id)
       INSERT INTO variable (id, application_id, name, data_type, scope, origin_screen_id)
       SELECT id, $1, $2, 'TEXT', $3::variable_scope, $4 FROM e RETURNING id`,
      [appId, name, scope, origin],
    );
    await t.owner.query(
      `INSERT INTO element_environment (element_id, element_type, environment) VALUES ($1, 'VARIABLE', 'DEV')`,
      [id],
    );
    await t.owner.query('COMMIT');
    return id;
  };

  before(async () => {
    t = await startTestApp({ reportServerErrors: false }); // it causes database errors on purpose
    ids.appA = await q(
      `INSERT INTO application (name, platform, created_by) VALUES ('SAR', 'Power Apps', $1) RETURNING id`,
      [t.users.admin.id],
    );
    ids.appB = await q(
      `INSERT INTO application (name, platform, created_by) VALUES ('Otra App', 'Power Apps', $1) RETURNING id`,
      [t.users.admin.id],
    );
    ids.appContext = await q(`SELECT id FROM screen WHERE application_id = $1 AND is_app_context`, [ids.appA]);
    ids.s1 = await newScreen(ids.appA, 'Solicitudes');
    ids.s2 = await newScreen(ids.appA, 'Otra');
    ids.sB = await newScreen(ids.appB, 'Pantalla B');
    ids.gUsuario = await newVariable(ids.appA, 'gUsuario', 'GLOBAL', null);
    ids.locFiltro = await newVariable(ids.appA, 'locFiltro', 'CONTEXT', ids.s1);
    ids.vB = await newVariable(ids.appB, 'vB', 'GLOBAL', null);
    await t.owner.query(
      `INSERT INTO screen_variable (screen_id, variable_id, access_mode, used_in) VALUES ($1, $2, 'READ', 'x')`,
      [ids.s1, ids.gUsuario],
    );
    await t.owner.query(
      `INSERT INTO screen_variable (screen_id, variable_id, access_mode, used_in) VALUES ($1, $2, 'READ', 'btn.Text')`,
      [ids.s1, ids.locFiltro],
    );
    await t.owner.query('BEGIN');
    ids.cReq = await q(
      `WITH e AS (INSERT INTO documented_element (type, application_id) VALUES ('COLLECTION', $1) RETURNING id)
       INSERT INTO collection (id, application_id, name) SELECT id, $1, 'cReq' FROM e RETURNING id`,
      [ids.appA],
    );
    await t.owner.query(
      `INSERT INTO element_environment (element_id, element_type, environment) VALUES ($1, 'COLLECTION', 'DEV')`,
      [ids.cReq],
    );
    await t.owner.query('COMMIT');
    await t.owner.query(
      `INSERT INTO collection_field (collection_id, name, data_type, position) VALUES ($1, 'Id', 'NUMBER', 0)`,
      [ids.cReq],
    );
    await t.owner.query(
      `INSERT INTO screen_collection (screen_id, collection_id, access_mode, used_in) VALUES ($1, $2, 'READ', 'y')`,
      [ids.s1, ids.cReq],
    );
    await t.owner.query(
      `INSERT INTO variable_collection (variable_id, variable_scope, collection_id, screen_id, assignment_function, used_in) VALUES ($1, 'GLOBAL', $2, $3, 'SET', 'z')`,
      [ids.gUsuario, ids.cReq, ids.s1],
    );
    ids.cmp = await q(
      `WITH e AS (INSERT INTO documented_element (type, application_id) VALUES ('COMPONENT', $1) RETURNING id)
       INSERT INTO component (id, application_id, screen_id, name, type) SELECT id, $1, $2, 'btnFiltrar', 'Button' FROM e RETURNING id`,
      [ids.appA, ids.s1],
    );
    ids.report = await q(
      `INSERT INTO report (application_id, title, format, parameters, generated_by) VALUES ($1, 'R', 'PDF', '{}', $2) RETURNING id`,
      [ids.appA, t.users.admin.id],
    );

    const appA = ids.appA;
    const dup = (type: string, name: string, scope: string, container: string): Expect => ({
      status: 409,
      code: 'DUPLICATE_NAME',
      message: `${/^[aeiou]/.test(type) ? 'An' : 'A'} ${type} named ${name} already exists in ${scope}.`,
      details: { field: 'name', type, name, application: scope, container },
    });
    const UNIQUE_MESSAGE = 'This value is repeated. Each one must be unique.';
    const validation = (
      field: string,
      rule: string,
      message = rule === 'unique' ? UNIQUE_MESSAGE : undefined,
    ): Expect => ({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Check the highlighted fields.',
      details: { fields: [{ field, rule, ...(message ? { message } : {}) }] },
    });
    const notFound = (element: string): Expect => ({
      status: 404,
      code: 'NOT_FOUND',
      message: `This ${element} doesn't exist. It may have been deleted.`,
      details: { element, id: null },
    });
    const internal = (logReason: string | RegExp): Expect => ({ status: 500, code: 'INTERNAL_ERROR', logReason });
    const element = (type: string) =>
      `WITH e AS (INSERT INTO documented_element (type, application_id) VALUES ('${type}', $1) RETURNING id)`;

    scenarios = [
      {
        name: 'unique e-mail',
        op: 'createUser',
        run: sql(
          `INSERT INTO app_user (name, email, password_hash, role, status) VALUES ('X', 'admin@test.local', 'h', 'READER', 'ACTIVE')`,
        ),
        expect: {
          status: 409,
          code: 'EMAIL_TAKEN',
          message: 'A user with this email already exists.',
          details: { field: 'email' },
        },
      },
      {
        name: 'duplicate application name',
        op: 'createApplication',
        body: { name: 'SAR' },
        run: sql(`INSERT INTO application (name, platform, created_by) VALUES ('SAR', 'p', ${t.users.admin.id})`),
        expect: dup('application', 'SAR', 'Documentación técnica', 'system'),
      },
      {
        name: 'duplicate screen name',
        op: 'createScreen',
        body: { applicationId: appA, name: 'Solicitudes' },
        run: sql(
          `${element('SCREEN')} INSERT INTO screen (id, application_id, name, author_id) SELECT id, $1, 'Solicitudes', ${t.users.admin.id} FROM e`,
          appA,
        ),
        expect: dup('screen', 'Solicitudes', 'SAR', 'application'),
      },
      {
        name: 'duplicate global variable name (update: the application comes from the variable id)',
        op: 'updateVariable',
        body: { name: 'gUsuario', scope: 'GLOBAL' },
        pathId: ids.gUsuario,
        run: sql(
          `${element('VARIABLE')} INSERT INTO variable (id, application_id, name, data_type, scope) SELECT id, $1, 'gUsuario', 'TEXT', 'GLOBAL' FROM e`,
          appA,
        ),
        expect: dup('global variable', 'gUsuario', 'SAR', 'application'),
      },
      {
        name: 'duplicate context variable name',
        op: 'createVariable',
        body: { applicationId: appA, name: 'locFiltro', scope: 'CONTEXT', originScreenId: ids.s1 },
        run: sql(
          `${element('VARIABLE')} INSERT INTO variable (id, application_id, name, data_type, scope, origin_screen_id) SELECT id, $1, 'locFiltro', 'TEXT', 'CONTEXT', ${ids.s1} FROM e`,
          appA,
        ),
        expect: dup('context variable', 'locFiltro', 'Solicitudes', 'screen'),
      },
      {
        name: 'duplicate collection name',
        op: 'createCollection',
        body: { applicationId: appA, name: 'cReq' },
        run: sql(
          `${element('COLLECTION')} INSERT INTO collection (id, application_id, name) SELECT id, $1, 'cReq' FROM e`,
          appA,
        ),
        expect: dup('collection', 'cReq', 'SAR', 'application'),
      },
      {
        name: 'repeated component name in the body',
        op: 'updateScreen',
        run: sql(
          `${element('COMPONENT')} INSERT INTO component (id, application_id, screen_id, name, type) SELECT id, $1, ${ids.s1}, 'btnFiltrar', 'Button' FROM e`,
          appA,
        ),
        expect: validation('components[].name', 'unique'),
      },
      {
        name: 'repeated field name in the body',
        op: 'updateCollection',
        run: sql(
          `INSERT INTO collection_field (collection_id, name, data_type, position) VALUES (${ids.cReq}, 'Id', 'TEXT', 1)`,
        ),
        expect: validation('fields[].name', 'unique'),
      },
      {
        name: 'repeated variable link',
        op: 'updateScreen',
        run: sql(
          `INSERT INTO screen_variable (screen_id, variable_id, access_mode, used_in) VALUES (${ids.s1}, ${ids.gUsuario}, 'READ', 'x')`,
        ),
        expect: validation('variableLinks[].usedIn', 'unique'),
      },
      {
        name: 'repeated collection link',
        op: 'updateScreen',
        run: sql(
          `INSERT INTO screen_collection (screen_id, collection_id, access_mode, used_in) VALUES (${ids.s1}, ${ids.cReq}, 'READ', 'y')`,
        ),
        expect: validation('collectionLinks[].usedIn', 'unique'),
      },
      {
        name: 'repeated assignment',
        op: 'updateCollection',
        run: sql(
          `INSERT INTO variable_collection (variable_id, variable_scope, collection_id, screen_id, assignment_function, used_in) VALUES (${ids.gUsuario}, 'GLOBAL', ${ids.cReq}, ${ids.s1}, 'SET', 'z')`,
        ),
        expect: validation('variableAssignments[].usedIn', 'unique'),
      },
      {
        name: 'same environment twice',
        op: 'updateVariable',
        run: sql(
          `INSERT INTO element_environment (element_id, element_type, environment) VALUES (${ids.gUsuario}, 'VARIABLE', 'DEV')`,
        ),
        expect: validation('environments[].environment', 'unique'),
      },
      {
        name: 'Set on a context variable (collection write)',
        op: 'updateCollection',
        run: sql(
          `INSERT INTO variable_collection (variable_id, variable_scope, collection_id, screen_id, assignment_function, used_in) VALUES (${ids.gUsuario}, 'GLOBAL', ${ids.cReq}, ${ids.s1}, 'UPDATE_CONTEXT', 'q')`,
        ),
        expect: {
          status: 422,
          code: 'SCOPE_MISMATCH',
          message: 'Set applies to global variables and UpdateContext to context variables.',
          details: { field: 'variableAssignments[].assignmentFunction' },
        },
      },
      {
        name: 'scope change with incompatible assignments (cascade)',
        op: 'updateVariable',
        body: { scope: 'CONTEXT' },
        pathId: ids.gUsuario,
        run: sql(`UPDATE variable SET scope = 'CONTEXT', origin_screen_id = ${ids.s1} WHERE id = ${ids.gUsuario}`),
        expect: {
          status: 422,
          code: 'SCOPE_CONFLICT',
          message:
            "You can't change the scope while collections assign this variable with Set. Update those assignments first.",
          details: { function: 'Set' },
        },
      },
      {
        name: 'blank name (CHECK)',
        op: 'updateUser',
        run: sql(`UPDATE app_user SET name = '  ' WHERE id = ${t.users.reader.id}`),
        expect: validation('name', 'CHECK', 'Must not be blank.'),
      },
      {
        name: 'miro link without https (CHECK)',
        op: 'updateScreen',
        run: sql(`UPDATE screen SET miro_link = 'http://miro.com/x' WHERE id = ${ids.s1}`),
        expect: validation('miroLink', 'CHECK', 'Must start with https://.'),
      },
      {
        name: 'invalid Jira project key (CHECK)',
        op: 'updateApplication',
        run: sql(`UPDATE application SET jira_project_key = 'bad key' WHERE id = ${ids.appA}`),
        expect: validation(
          'jiraProjectKey',
          'CHECK',
          'Must be 2-20 characters: capital letters, digits or "_", starting with a letter.',
        ),
      },
      {
        name: 'negative field position (CHECK)',
        op: 'createCollection',
        run: sql(
          `INSERT INTO collection_field (collection_id, name, data_type, position) VALUES (${ids.cReq}, 'Neg', 'TEXT', -1)`,
        ),
        expect: validation('fields[].position', 'CHECK', 'Must be zero or greater.'),
      },
      {
        name: 'link across applications (trigger)',
        op: 'updateScreen',
        run: sql(
          `INSERT INTO screen_variable (screen_id, variable_id, access_mode, used_in) VALUES (${ids.s1}, ${ids.vB}, 'READ', 'cross')`,
        ),
        expect: {
          status: 422,
          code: 'CROSS_APPLICATION',
          message: 'You can only link elements of the same application.',
          details: null,
        },
      },
      {
        name: 'delete the App (OnStart) screen (trigger)',
        op: 'deleteScreen',
        run: sql(`DELETE FROM screen WHERE id = ${ids.appContext}`),
        expect: {
          status: 422,
          code: 'APP_CONTEXT_PROTECTED',
          message: "The App (OnStart) screen can't be deleted.",
          details: null,
        },
      },
      {
        name: 'unflag the App (OnStart) screen (trigger, unreachable from the API)',
        op: 'updateScreen',
        run: sql(`UPDATE screen SET is_app_context = false WHERE id = ${ids.appContext}`),
        expect: internal('APP_CONTEXT_FLAG'),
      },
      {
        name: 'variable without environment (deferred trigger at COMMIT)',
        op: 'createVariable',
        run: () =>
          t.db.auditedTransaction((tx) =>
            tx.$executeRawUnsafe(
              `${element('VARIABLE')} INSERT INTO variable (id, application_id, name, data_type, scope) SELECT id, $1, 'sinEntorno', 'TEXT', 'GLOBAL' FROM e`,
              appA,
            ),
          ),
        expect: validation('environments', 'CHECK', 'Select at least one environment (DEV or PROD).'),
      },
      {
        name: 'context variable read outside its origin screen (deferred trigger, CP-07)',
        op: 'updateScreen',
        run: () =>
          t.db.prisma.screenVariable.create({
            data: { screenId: ids.s2!, variableId: ids.locFiltro!, accessMode: 'READ', usedIn: 'otra.Text' },
          }),
        expect: {
          status: 422,
          code: 'CONTEXT_SCREEN_MISMATCH',
          message: 'locFiltro belongs to Solicitudes. From here you can only write it with Navigate.',
          details: {
            variableId: ids.locFiltro,
            variable: 'locFiltro',
            originScreenId: ids.s1,
            screen: 'Solicitudes',
            screenId: ids.s2,
            targetScreen: 'Otra',
          },
        },
      },
      {
        name: 'context variable left without origin (deferred trigger, D-64)',
        op: 'updateVariable',
        run: () => t.db.prisma.variable.update({ where: { id: ids.locFiltro! }, data: { originScreenId: null } }),
        expect: {
          status: 422,
          code: 'CONTEXT_SCREEN_MISMATCH',
          message: 'locFiltro has no origin screen. Set its origin screen before linking it.',
          details: {
            variableId: ids.locFiltro,
            variable: 'locFiltro',
            originScreenId: null,
            screenId: ids.s1,
            targetScreen: 'Solicitudes',
          },
        },
      },
      {
        name: 'link to a screen that does not exist (FK)',
        op: 'updateScreen',
        run: sql(
          `INSERT INTO screen_variable (screen_id, variable_id, access_mode, used_in) VALUES (999999, ${ids.gUsuario}, 'READ', 'nope')`,
        ),
        expect: notFound('screen'),
      },
      {
        name: 'element of an application that does not exist (FK)',
        op: 'createVariable',
        run: sql(`INSERT INTO documented_element (type, application_id) VALUES ('SCREEN', 999999)`),
        expect: notFound('application'),
      },
      {
        name: 'dependency to a target that does not exist (FK, screen write)',
        op: 'updateScreen',
        run: sql(
          `INSERT INTO dependency (source_id, source_type, target_id, target_type, relation_type) VALUES (${ids.cmp}, 'COMPONENT', 999999, 'VARIABLE', 'USES')`,
        ),
        expect: notFound('element'),
      },
      {
        name: 'derivation to a collection that does not exist (FK, collection write)',
        op: 'updateCollection',
        run: sql(
          `INSERT INTO dependency (source_id, source_type, target_id, target_type, relation_type) VALUES (${ids.cReq}, 'COLLECTION', 999999, 'COLLECTION', 'DERIVES_FROM')`,
        ),
        expect: notFound('collection'),
      },
      {
        name: 'a collection derived from itself (CHECK, collection write): 400 at its position in derivedFrom (D-74)',
        op: 'updateCollection',
        body: { derivedFrom: [999999, ids.cReq] },
        pathId: ids.cReq,
        run: sql(
          `INSERT INTO dependency (source_id, source_type, target_id, target_type, relation_type) VALUES (${ids.cReq}, 'COLLECTION', ${ids.cReq}, 'COLLECTION', 'DERIVES_FROM')`,
        ),
        expect: validation('derivedFrom[1]', 'self', 'A collection cannot derive from itself.'),
      },
      {
        name: 'a screen navigating to itself (CHECK, screen write): 400 at its position in navigations (D-84)',
        op: 'updateScreen',
        body: { navigations: [{ targetScreenId: 999999 }, { targetScreenId: ids.s1 }] },
        pathId: ids.s1,
        run: sql(
          `INSERT INTO dependency (source_id, source_type, target_id, target_type, relation_type) VALUES (${ids.s1}, 'SCREEN', ${ids.s1}, 'SCREEN', 'NAVIGATES_TO')`,
        ),
        expect: validation('navigations[1].targetScreenId', 'self', 'A screen cannot navigate to itself.'),
      },
      {
        name: 'delete a referenced row (RESTRICT) is a defect',
        op: 'deactivateUser',
        run: sql(`DELETE FROM app_user WHERE id = ${t.users.admin.id}`),
        expect: internal('ACTOR_REFERENCE'),
      },
      {
        name: 'publish a report that is not READY (CHECK)',
        op: 'setReportPublication',
        pathId: ids.report,
        run: sql(`UPDATE report SET is_published = true, published_at = now() WHERE id = ${ids.report}`),
        expect: {
          status: 409,
          code: 'REPORT_NOT_READY',
          message: 'Only ready reports can be published or downloaded.',
          details: { status: 'PENDING' },
        },
      },
      {
        name: 'update of a record that does not exist (P2025)',
        op: 'updateUser',
        run: () => t.db.prisma.user.update({ where: { id: 987654 }, data: { name: 'Z' } }),
        expect: notFound('user'),
      },
      {
        name: 'id beyond the integer range (22003)',
        op: 'getUser',
        run: () => t.db.base.user.findUnique({ where: { id: 99_999_999_999 } }),
        expect: notFound('user'),
      },
      {
        name: 'invalid enum input (22P02)',
        op: 'updateUser',
        run: sql(`UPDATE app_user SET role = 'NOPE' WHERE id = ${t.users.reader.id}`),
        expect: internal('DB_22P02'),
      },
      {
        name: 'Prisma validation error (a bug)',
        op: 'listUsers',
        // @ts-expect-error unknown argument on purpose
        run: () => t.db.base.user.findMany({ where: { nope: 1 } }),
        expect: internal('"errorClass":"PrismaClientValidationError"'),
      },
      {
        name: 'direct write to audit_log is denied (42501)',
        op: 'updateUser',
        run: sql(`INSERT INTO audit_log (action, entity_type, entity_id) VALUES ('CREATE', 'app_user', '1')`),
        expect: internal('DB_42501'),
      },
      {
        name: 'invalid business event name (22023)',
        op: 'updateUser',
        run: () =>
          t.db.auditedTransaction((tx) => tx.$queryRawUnsafe(`SELECT log_business_event('bad', 'app_user', '1')`)),
        expect: internal('DB_22023'),
      },
      {
        name: 'leak check: Prisma validation error whose message embeds a password hash argument',
        op: 'createUser',
        run: () =>
          t.db.prisma.user.create({
            // @ts-expect-error invalid role on purpose: Prisma echoes the arguments in its message
            data: { name: 'LEAKME-name', email: 'leak@test.local', passwordHash: 'LEAKME-hash', role: 'NOPE' },
          }),
        expect: internal('"errorClass":"PrismaClientValidationError"'),
      },
      {
        name: 'leak check: PostgreSQL message that quotes the rejected value',
        op: 'updateUser',
        run: sql(`UPDATE app_user SET role = $1 WHERE id = $2`, 'LEAKME-role', t.users.reader.id),
        expect: internal('DB_22P02'),
      },
    ];

    const app = express();
    app.use(express.json());
    app.use(requestContext(t.built.logger));
    app.post('/run/:index', (req, res, next) => {
      const s = scenarios[Number(req.params.index)]!;
      req.policy = policies.get(s.op)!;
      res.locals.pathParams = s.pathId === undefined ? {} : { id: String(s.pathId) };
      auditContext.run({ userId: t.users.admin.id }, () => {
        s.run().then(() => res.json({ ok: true }), next);
      });
    });
    app.use(createErrorHandler({ db: t.db, logger: t.built.logger }));
    http = supertest(app);
  });
  after(async () => {
    await t.close();
  });

  // Scenarios are registered by index so each one runs against the state its predecessors left; the
  // destructive ones (RESTRICT, App context) come last in the list.
  it('every scenario answers with the uniform format and the exact catalog message', async () => {
    const failures: string[] = [];
    for (const [index, s] of scenarios.entries()) {
      const res = await http.post(`/run/${index}`).send(s.body ?? {});
      const body = res.body as { code: string; message: string; details: unknown };
      const requestId = res.headers['x-request-id'];
      try {
        assert.equal(res.status, s.expect.status, 'status');
        assert.equal(body.code, s.expect.code, 'code');
        assert.deepEqual(Object.keys(body).sort(), ['code', 'details', 'message']);
        if (s.expect.message !== undefined) assert.equal(body.message, s.expect.message, 'message');
        if (s.expect.details !== undefined) assert.deepEqual(body.details, s.expect.details, 'details');
        if (s.expect.status === 500) {
          assert.deepEqual(body.details, { requestId });
          assert.equal(
            body.message,
            `Something went wrong on our side. Try again in a moment. Reference: ${String(requestId)}.`,
          );
          assert.doesNotMatch(
            JSON.stringify(body),
            /constraint|SQL|violat|prisma|app_user|audit_log|stack/i,
            'no internals',
          );
          const line = t.logs.find((l) => l.includes(String(requestId)) && l.includes('request failed'));
          assert.ok(line, 'the 500 is logged with the same requestId');
          if (s.expect.logReason !== undefined) {
            assert.match(
              line,
              s.expect.logReason instanceof RegExp ? s.expect.logReason : new RegExp(s.expect.logReason),
            );
          }
        }
      } catch (e) {
        failures.push(
          `${s.name}: ${(e as Error).message.split('\n').slice(0, 4).join(' | ')} -> ${res.status} ${JSON.stringify(body).slice(0, 300)}`,
        );
      }
    }
    assert.deepEqual(failures, []);
  });

  it('a 500 logs safe diagnostic fields and never values, arguments or password hashes', async () => {
    const secrets = { passwordHash: 'LEAKME-body-hash', password: 'LEAKME-body-pw', name: 'LEAKME-body-name' };
    let checked = 0;
    for (const [index, s] of scenarios.entries()) {
      if (s.expect.status !== 500) continue;
      const res = await http.post(`/run/${index}`).send(secrets);
      const requestId = String(res.headers['x-request-id']);
      const line = t.logs.find((l) => l.includes(requestId) && l.includes('request failed'));
      assert.ok(line, s.name);
      const entry = JSON.parse(line) as Record<string, unknown>;
      assert.equal(entry.requestId, requestId, s.name);
      assert.equal(entry.method, 'POST', s.name);
      assert.equal(entry.path, `/run/${index}`, s.name);
      assert.equal(typeof entry.errorClass, 'string', s.name);
      assert.ok(String(entry.errorClass).length > 0, s.name);
      assert.ok(entry.errorClass !== 'DatabaseError', 'the real class name is logged, not a label');
      if (typeof s.expect.logReason === 'string' && s.expect.logReason.startsWith('DB_')) {
        assert.equal(entry.sqlstate, s.expect.logReason.slice(3), s.name);
        assert.equal(entry.prismaCode, 'P2010', s.name);
      }
      for (const key of ['message', 'detail', 'stack']) {
        if (entry.errorClass !== 'Error')
          assert.equal(entry[key], undefined, `${s.name}: no ${key} of a database or Prisma error`);
      }
      checked += 1;
    }
    assert.ok(checked >= 8, 'several 500 classes were checked');
    const everything = t.logs.join(' | ');
    assert.doesNotMatch(
      everything,
      /passwordHash|LEAKME/,
      'no password hash, query argument or body value in any log line',
    );
  });
});
