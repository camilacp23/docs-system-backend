/**
 * Bulk data for the search tests that need many elements (the light scale test and the performance test): screens with
 * seven long template fields, variables, collections with fields, components and links, inserted with a handful of
 * statements on the owner connection of the disposable database. The common word "filtro" ends the text of one in five
 * screens and of one in four of the other elements, so a text search has something to find and something to skip.
 */
import type { TestApp } from './app.js';

/** How much to insert. `repeat` is how many times "lorem ipsum dolor sit amet " opens each template field (28 characters each). */
export type SearchDataSize = {
  screens: number;
  variables: number;
  collections: number;
  components: number;
  fieldsPerCollection: number;
  links: number;
  repeat: number;
};

/** What the data holds that a test may need. */
export type SearchData = { screenIds: number[]; variableIds: number[] };

/** The SQL of one template field: the opening, a salt that tells the fields apart, and the common word for 1 in 5. */
const field = (salt: string, repeat: number): string =>
  `repeat('lorem ipsum dolor sit amet ', ${repeat}) || '${salt}' || CASE WHEN id % 5 = 0 THEN ' filtro de busqueda' ELSE '' END`;

/**
 * Inserts the data in one application, in one transaction.
 *
 * @param t - The test app (its owner connection and users are used).
 * @param applicationId - An existing application.
 * @param size - How much to insert.
 */
export async function loadSearchData(t: Pick<TestApp, 'owner' | 'users'>, applicationId: number, size: SearchDataSize) {
  if (!Number.isInteger(size.repeat) || size.repeat < 0) throw new Error('repeat must be a whole number');
  const salts = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((salt) => field(salt, size.repeat));
  await t.owner.query('BEGIN');
  try {
    await t.owner.query(
      `WITH ins AS (INSERT INTO documented_element (type, application_id)
                    SELECT 'SCREEN'::element_type, $1 FROM generate_series(1, $2::int) RETURNING id)
       INSERT INTO screen (id, application_id, name, author_id, documentation_status,
                           on_start, working_process, architecture, data_model, requirements, known_issues, risks)
       SELECT id, $1, 'perfScreen' || id, $3,
              (ARRAY['UNDOCUMENTED','DRAFT','IN_PROGRESS','IN_REVIEW','APPROVED'])[1 + id % 5]::documentation_status,
              ${salts.join(', ')}
         FROM ins`,
      [applicationId, size.screens, t.users.admin.id],
    );
    await t.owner.query(
      `WITH ins AS (INSERT INTO documented_element (type, application_id)
                    SELECT 'VARIABLE'::element_type, $1 FROM generate_series(1, $2::int) RETURNING id),
            v AS (INSERT INTO variable (id, application_id, name, data_type, scope, description)
                  SELECT id, $1, 'gPerf' || id, 'TEXT', 'GLOBAL',
                         repeat('variable description ', 40) || CASE WHEN id % 4 = 0 THEN 'filtro' ELSE '' END
                    FROM ins RETURNING id)
       INSERT INTO element_environment (element_id, element_type, environment)
       SELECT id, 'VARIABLE'::element_type, 'DEV'::environment FROM v
       UNION ALL SELECT id, 'VARIABLE'::element_type, 'PROD'::environment FROM v WHERE id % 2 = 0`,
      [applicationId, size.variables],
    );
    await t.owner.query(
      `WITH ins AS (INSERT INTO documented_element (type, application_id)
                    SELECT 'COLLECTION'::element_type, $1 FROM generate_series(1, $2::int) RETURNING id),
            c AS (INSERT INTO collection (id, application_id, name, creation_condition, description)
                  SELECT id, $1, 'colPerf' || id, 'OnStart: ClearCollect(colPerf, Table)',
                         repeat('collection description ', 40) || CASE WHEN id % 4 = 0 THEN 'filtro' ELSE '' END
                    FROM ins RETURNING id),
            f AS (INSERT INTO collection_field (collection_id, name, data_type, position)
                  SELECT c.id, 'field' || g, 'TEXT', g FROM c CROSS JOIN generate_series(1, $3::int) g)
       INSERT INTO element_environment (element_id, element_type, environment)
       SELECT id, 'COLLECTION'::element_type, 'DEV'::environment FROM c`,
      [applicationId, size.collections, size.fieldsPerCollection],
    );
    const screenIds = (
      await t.owner.query<{ id: number }>(`SELECT id FROM screen WHERE application_id = $1 ORDER BY id`, [
        applicationId,
      ])
    ).rows.map((r) => r.id);
    await t.owner.query(
      `WITH ins AS (INSERT INTO documented_element (type, application_id)
                    SELECT 'COMPONENT'::element_type, $1 FROM generate_series(1, $2::int) RETURNING id)
       INSERT INTO component (id, application_id, screen_id, name, type, on_select, description)
       SELECT id, $1, ($3::int[])[1 + id % cardinality($3::int[])], 'cmpPerf' || id, 'Button',
              'Filter(colPerf, Active = true) ' || repeat('x', 200),
              repeat('component description ', 20) || CASE WHEN id % 4 = 0 THEN 'filtro' ELSE '' END
         FROM ins`,
      [applicationId, size.components, screenIds],
    );
    const variableIds = (
      await t.owner.query<{ id: number }>(`SELECT id FROM variable WHERE application_id = $1 ORDER BY id`, [
        applicationId,
      ])
    ).rows.map((r) => r.id);
    await t.owner.query(
      `INSERT INTO screen_variable (screen_id, variable_id, access_mode, used_in)
       SELECT ($1::int[])[1 + n % cardinality($1::int[])], ($2::int[])[1 + n % cardinality($2::int[])],
              'READ', 'perf link ' || n
         FROM generate_series(1, $3::int) n`,
      [screenIds, variableIds, size.links],
    );
    await t.owner.query('COMMIT');
    await t.owner.query('ANALYZE');
    return { screenIds, variableIds } satisfies SearchData;
  } catch (error) {
    await t.owner.query('ROLLBACK');
    throw error;
  }
}
