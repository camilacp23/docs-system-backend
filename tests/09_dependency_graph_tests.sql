-- =====================================================================
-- Dependency-graph query test (FR-15). Run as a superuser on a DISPOSABLE
-- copy of the migrated database:
--   psql -d <copy> -v graph_sql="$(cat src/modules/dependencies/graph.sql)" -f tests/09_dependency_graph_tests.sql
-- Seeds two applications and checks node and edge counts per kind.
-- =====================================================================
\pset pager off
\set QUIET on
SET client_min_messages = notice;
INSERT INTO app_user (name, email, password_hash, role) VALUES ('Admin', 'admin@dept.local', 'x', 'ADMINISTRATOR');
INSERT INTO application (name, platform, created_by) VALUES ('SAR', 'Power Apps', 1), ('OTRA', 'Power Apps', 1);  -- App (OnStart) screens 1 and 2
BEGIN;
INSERT INTO documented_element (id, type, application_id) VALUES
  (10,'SCREEN',1),(11,'SCREEN',1),(20,'VARIABLE',1),(21,'VARIABLE',1),(30,'COLLECTION',1),(31,'COLLECTION',1),(40,'COMPONENT',1),(41,'COMPONENT',1),
  (90,'SCREEN',2),(91,'VARIABLE',2);
INSERT INTO screen (id, application_id, name, author_id) VALUES (10,1,'Solicitudes',1),(11,1,'Detalle',1),(90,2,'Inicio',1);
INSERT INTO variable (id, application_id, name, data_type, scope, origin_screen_id) VALUES
  (20,1,'gUsuario','RECORD','GLOBAL',1),(21,1,'locFiltro','TEXT','CONTEXT',10),(91,2,'gOtra','TEXT','GLOBAL',90);
INSERT INTO element_environment VALUES (20,'VARIABLE','DEV'),(21,'VARIABLE','DEV'),(91,'VARIABLE','DEV');
INSERT INTO collection (id, application_id, name) VALUES (30,1,'colSolicitudes'),(31,1,'colActivas');
INSERT INTO element_environment VALUES (30,'COLLECTION','DEV'),(31,'COLLECTION','DEV');
INSERT INTO component (id, application_id, screen_id, name, type) VALUES (40,1,10,'btnFiltrar','Button'),(41,1,10,'galSolicitudes','Gallery');
COMMIT;
INSERT INTO screen_variable (screen_id, variable_id, access_mode, used_in) VALUES (10,21,'READ','galSolicitudes.Items');
INSERT INTO screen_collection (screen_id, collection_id, access_mode, used_in) VALUES (10,30,'READ','galSolicitudes.Items');
INSERT INTO variable_collection (variable_id, variable_scope, collection_id, screen_id, assignment_function, table_function, used_in)
VALUES (20,'GLOBAL',30,1,'SET','First','OnStart');
INSERT INTO dependency (source_id, source_type, target_id, target_type, relation_type) VALUES
  (40,'COMPONENT',21,'VARIABLE','USES'),(41,'COMPONENT',30,'COLLECTION','USES'),
  (31,'COLLECTION',30,'COLLECTION','DERIVES_FROM'),(10,'SCREEN',11,'SCREEN','NAVIGATES_TO');

-- Wrap the exact production query in a temporary function (no copy of the SQL in this test)
\set graph_sql `cat src/modules/dependencies/graph.sql`
SELECT format('CREATE FUNCTION pg_temp.dependency_graph(int) RETURNS json LANGUAGE sql AS %L', :'graph_sql') \gexec
CREATE TEMP TABLE gj AS SELECT a AS app, pg_temp.dependency_graph(a) AS g FROM (VALUES (1), (2)) v(a);
DO $$
DECLARE j json := (SELECT g FROM gj WHERE app = 1); k json := (SELECT g FROM gj WHERE app = 2);
  n int; e int; kinds text;
BEGIN
  n := json_array_length(j -> 'nodes'); e := json_array_length(j -> 'edges');
  SELECT string_agg(kind || '=' || c, ', ' ORDER BY kind) INTO kinds
    FROM (SELECT x ->> 'kind' AS kind, count(*) c FROM json_array_elements(j -> 'edges') x GROUP BY 1) t;
  RAISE NOTICE '%  G01 SAR graph has 9 nodes (3 screens incl. App (OnStart), 2 variables, 2 collections, 2 components) -> %', CASE WHEN n = 9 THEN 'PASS' ELSE 'FAIL' END, n;
  RAISE NOTICE '%  G02 SAR graph has 11 edges -> % [%]', CASE WHEN e = 11 THEN 'PASS' ELSE 'FAIL' END, e, kinds;
  RAISE NOTICE '%  G03 edge kinds: ACCESSES=2, CONTAINS=2, CREATES=2, DERIVES_FROM=1, FEEDS=1, NAVIGATES_TO=1, USES=2',
    CASE WHEN kinds = 'ACCESSES=2, CONTAINS=2, CREATES=2, DERIVES_FROM=1, FEEDS=1, NAVIGATES_TO=1, USES=2' THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  G04 origin rows are not duplicated as ACCESSES',
    CASE WHEN NOT EXISTS (SELECT 1 FROM json_array_elements(j -> 'edges') x WHERE x ->> 'kind' = 'ACCESSES' AND x ->> 'used_in' = 'origin') THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  G05 every edge endpoint is a node of the same graph',
    CASE WHEN NOT EXISTS (SELECT 1 FROM json_array_elements(j -> 'edges') x
                          WHERE NOT EXISTS (SELECT 1 FROM json_array_elements(j -> 'nodes') nd WHERE nd ->> 'key' = x ->> 'source')
                             OR NOT EXISTS (SELECT 1 FROM json_array_elements(j -> 'nodes') nd WHERE nd ->> 'key' = x ->> 'target')) THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  G06 the other application is isolated (3 nodes: App (OnStart), Inicio, gOtra; 1 CREATES edge)',
    CASE WHEN json_array_length(k -> 'nodes') = 3 AND json_array_length(k -> 'edges') = 1 THEN 'PASS' ELSE 'FAIL' END;
  RAISE NOTICE '%  G07 untraced flag: gUsuario and locFiltro have origin, so 0 untraced variables',
    CASE WHEN NOT EXISTS (SELECT 1 FROM json_array_elements(j -> 'nodes') nd WHERE (nd ->> 'untraced')::boolean) THEN 'PASS' ELSE 'FAIL' END;
END $$;
