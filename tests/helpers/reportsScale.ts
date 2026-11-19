/**
 * Bulk documentation for the report measurements: screens with the seven long template fields, components with a
 * formula, variables, collections with their fields and links, written with a few statements on the owner connection of
 * a disposable database. The text of every field is different for every row (a chain of hashes), so it does not compress
 * better than real documentation would.
 */
import type { TestApp } from './app.js';

/** How much to insert. */
export type ReportScale = {
  screens: number;
  /** Characters of each of the seven template fields of a screen. */
  templateChars: number;
  components: number;
  /** Characters of the formula of a component. */
  formulaChars: number;
  variables: number;
  collections: number;
  fieldsPerCollection: number;
  /** `NAVIGATES_TO` edges between screens. */
  navigations: number;
};

/** About a department: the size of the application of `npm run sandbox:graph` and of the search tests (5 KB per field). */
export const DEPARTMENT_SCALE: ReportScale = {
  screens: 500,
  templateChars: 5000,
  components: 3000,
  formulaChars: 500,
  variables: 1000,
  collections: 300,
  fieldsPerCollection: 10,
  navigations: 1000,
};

/** A light version for `npm test`. */
export const LIGHT_REPORT_SCALE: ReportScale = {
  screens: 20,
  templateChars: 600,
  components: 60,
  formulaChars: 120,
  variables: 40,
  collections: 10,
  fieldsPerCollection: 4,
  navigations: 30,
};

/** The kind of text: hashes (every word unique: the worst case for the layout cache) or words that repeat, like prose. */
export type TextKind = 'realistic' | 'random';

/** A vocabulary of 4000 distinct lowercase words of 3 to 12 letters, the same on every run. */
const VOCABULARY: string[] = (() => {
  const out: string[] = [];
  let seed = 7;
  const next = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  for (let i = 0; i < 4000; i += 1) {
    let word = '';
    const length = 3 + (i % 10);
    for (let k = 0; k < length; k += 1) word += String.fromCharCode(97 + ((next() >> 8) % 26));
    out.push(`${word}${i.toString(36)}`);
  }
  return out;
})();

/** SQL of a function that makes `chars` characters of words picked with a skew (few words are very frequent). */
const REALISTIC_FUNCTION = `CREATE OR REPLACE FUNCTION pg_temp.realistic_text(chars int) RETURNS text LANGUAGE sql AS $$
  SELECT left(string_agg((ARRAY[${VOCABULARY.map((w) => `'${w}'`).join(',')}])[1 + floor(power(random(), 2.2) * 4000)::int], ' '), chars)
    FROM generate_series(1, chars / 5 + 2) $$`;

/** What was inserted, to compare with the file. */
export type ReportTruth = {
  screens: number;
  components: number;
  variables: number;
  collections: number;
  fields: number;
};

/**
 * Inserts the documentation in an existing application, in one transaction.
 *
 * @param t - The test app (its owner connection and admin user are used).
 * @param applicationId - An existing application (its App (OnStart) screen exists).
 * @param scale - How much to insert.
 */
export async function loadReportData(
  t: Pick<TestApp, 'owner' | 'users'>,
  applicationId: number,
  scale: ReportScale,
  kind: TextKind = 'random',
): Promise<ReportTruth> {
  /** A different text per row and field: a chain of md5 hashes, or words of the vocabulary. */
  const TEXT = (seed: string, chars: number): string =>
    kind === 'realistic'
      ? `pg_temp.realistic_text(${chars})`
      : `(SELECT left(string_agg(md5(i::text || ${seed}), ' '), ${chars}) FROM generate_series(1, ${Math.ceil(chars / 33)}) i)`;
  if (kind === 'realistic') await t.owner.query(REALISTIC_FUNCTION);
  const author = t.users.admin.id;
  const q = (sql: string, params: unknown[]) => t.owner.query(sql, params);
  await t.owner.query('BEGIN');
  try {
    await q(
      `WITH e AS (INSERT INTO documented_element (type, application_id)
                  SELECT 'SCREEN'::element_type, $1::int FROM generate_series(1, $2::int) RETURNING id)
       INSERT INTO screen (id, application_id, name, author_id, documentation_status, on_start, working_process,
                           architecture, data_model, requirements, known_issues, risks, miro_link)
       SELECT id, $1::int, 'Screen ' || id, $3::int,
              (ARRAY['UNDOCUMENTED','DRAFT','IN_PROGRESS','IN_REVIEW','APPROVED'])[1 + id % 5]::documentation_status,
              ${TEXT("'a' || id", scale.templateChars)}, ${TEXT("'b' || id", scale.templateChars)},
              ${TEXT("'c' || id", scale.templateChars)}, ${TEXT("'d' || id", scale.templateChars)},
              ${TEXT("'e' || id", scale.templateChars)}, ${TEXT("'f' || id", scale.templateChars)},
              ${TEXT("'g' || id", scale.templateChars)}, 'https://miro.com/app/board/' || id
         FROM e`,
      [applicationId, scale.screens, author],
    );
    const screens = (
      await q(`SELECT id FROM screen WHERE application_id = $1 AND NOT is_app_context ORDER BY id`, [applicationId])
    ).rows.map((r: { id: number }) => r.id);
    await q(
      `WITH e AS (INSERT INTO documented_element (type, application_id)
                  SELECT 'COMPONENT'::element_type, $1::int FROM generate_series(1, $3::int) RETURNING id)
       INSERT INTO component (id, application_id, screen_id, name, type, on_select, description)
       SELECT id, $1::int, ($2::int[])[1 + id % cardinality($2::int[])], 'Component ' || id, 'Button',
              ${TEXT("'o' || id", scale.formulaChars)}, 'Component description ' || id
         FROM e`,
      [applicationId, screens, scale.components],
    );
    await q(
      `WITH e AS (INSERT INTO documented_element (type, application_id)
                  SELECT 'VARIABLE'::element_type, $1::int FROM generate_series(1, $3::int) RETURNING id),
            v AS (INSERT INTO variable (id, application_id, name, data_type, scope, origin_screen_id, description)
                  SELECT id, $1::int, 'gVar' || id, 'TEXT'::data_type, 'GLOBAL'::variable_scope,
                         CASE WHEN id % 3 = 0 THEN NULL ELSE ($2::int[])[1 + id % cardinality($2::int[])] END,
                         ${TEXT("'v' || id", 300)}
                    FROM e RETURNING id)
       INSERT INTO element_environment (element_id, element_type, environment)
       SELECT id, 'VARIABLE'::element_type, env::environment FROM v CROSS JOIN (VALUES ('DEV'), ('PROD')) AS x(env)`,
      [applicationId, screens, scale.variables],
    );
    await q(
      `WITH e AS (INSERT INTO documented_element (type, application_id)
                  SELECT 'COLLECTION'::element_type, $1::int FROM generate_series(1, $2::int) RETURNING id),
            c AS (INSERT INTO collection (id, application_id, name, creation_condition, description)
                  SELECT id, $1::int, 'colAll' || id, ${TEXT("'c' || id", 200)}, ${TEXT("'d' || id", 200)} FROM e RETURNING id),
            env AS (INSERT INTO element_environment (element_id, element_type, environment)
                    SELECT id, 'COLLECTION'::element_type, 'DEV'::environment FROM c)
       INSERT INTO collection_field (collection_id, name, data_type, position, description)
       SELECT c.id, 'field' || k, 'TEXT'::data_type, k, 'Field ' || k || ' of ' || c.id
         FROM c CROSS JOIN generate_series(1, $3::int) k`,
      [applicationId, scale.collections, scale.fieldsPerCollection],
    );
    await q(
      `INSERT INTO dependency (source_id, source_type, target_id, target_type, relation_type)
       SELECT s.id, 'SCREEN', t.id, 'SCREEN', 'NAVIGATES_TO'
         FROM generate_series(1, $2::int) k
         JOIN LATERAL (SELECT ($1::int[])[1 + (k * 7) % cardinality($1::int[])] AS id) s ON true
         JOIN LATERAL (SELECT ($1::int[])[1 + (k * 13 + 1) % cardinality($1::int[])] AS id) t ON true
        WHERE s.id <> t.id
       ON CONFLICT DO NOTHING`,
      [screens, scale.navigations],
    );
    await q(
      `INSERT INTO screen_collection (screen_id, collection_id, access_mode, used_in)
       SELECT ($2::int[])[1 + c.id % cardinality($2::int[])], c.id, 'READ'::access_mode, 'Screen.OnVisible'
         FROM collection c WHERE c.application_id = $1 AND c.id % 2 = 0`,
      [applicationId, screens],
    );
    await t.owner.query('COMMIT');
  } catch (error) {
    await t.owner.query('ROLLBACK');
    throw error;
  }
  return {
    screens: scale.screens,
    components: scale.components,
    variables: scale.variables,
    collections: scale.collections,
    fields: scale.collections * scale.fieldsPerCollection,
  };
}
