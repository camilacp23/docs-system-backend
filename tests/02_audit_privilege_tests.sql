-- =====================================================================
-- Audit + privilege test suite
-- Run AS THE API ROLE (docs_app) on a disposable copy of the migrated DB:
--   PGPASSWORD=*** psql -h localhost -U docs_app -d <copy> -f tests/02_audit_privilege_tests.sql
-- Helpers live in pg_temp (docs_app has no CREATE on schema public).
-- =====================================================================
\pset pager off
\set QUIET on
SET client_min_messages = notice;

CREATE FUNCTION pg_temp.expect_error(label text, stmt text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
    RAISE NOTICE 'FAIL  % (statement was accepted)', label;
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'PASS  % -> rejected: %', label, SQLERRM;
  END;
END $$;
CREATE FUNCTION pg_temp.check(label text, ok boolean, detail text DEFAULT '') RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok THEN RAISE NOTICE 'PASS  % %', label, detail; ELSE RAISE NOTICE 'FAIL  % %', label, detail; END IF;
END $$;

-- ---------- Fixtures written by the API role, as the backend would ----------
BEGIN;
SELECT set_config('app.user_id', '', true);   -- bootstrap user: no actor yet
INSERT INTO app_user (name, email, password_hash, role) VALUES ('Admin', 'admin@dept.local', 'hash-1', 'ADMINISTRATOR');
COMMIT;

BEGIN;
SELECT set_config('app.user_id', '1', true);  -- from the JWT, same transaction
INSERT INTO application (name, platform, created_by) VALUES ('SAR', 'Power Apps', 1);
INSERT INTO documented_element (id, type, application_id) VALUES (100, 'SCREEN', 1), (101, 'VARIABLE', 1), (102, 'COMPONENT', 1);
INSERT INTO screen (id, application_id, name, author_id) VALUES (100, 1, 'Solicitudes', 1);
INSERT INTO variable (id, application_id, name, data_type, scope, origin_screen_id) VALUES (101, 1, 'gFiltro', 'TEXT', 'GLOBAL', 100);
INSERT INTO element_environment (element_id, element_type, environment) VALUES (101, 'VARIABLE', 'DEV');
INSERT INTO component (id, application_id, screen_id, name, type) VALUES (102, 1, 100, 'btnFiltrar', 'Button');
INSERT INTO comment (screen_id, user_id, text) VALUES (100, 1, 'Revisar el filtro');
COMMIT;

-- AU01 CREATE records carry the application user and the DB role
SELECT pg_temp.check('AU01 CREATE audited with actor and db_role',
  (SELECT count(*) = 1 FROM audit_log WHERE entity_type = 'screen' AND entity_id = '100'
     AND action = 'CREATE' AND actor_user_id = 1 AND db_role = 'docs_app' AND entity_label = 'Solicitudes'
     AND application_id = 1));
SELECT pg_temp.check('AU02 trigger-generated rows are audited too (origin link, App screen)',
  (SELECT count(*) FROM audit_log WHERE entity_type = 'screen_variable' AND entity_label = 'origin' AND actor_user_id = 1) = 1
  AND (SELECT count(*) FROM audit_log WHERE entity_type = 'screen' AND entity_label = 'App (OnStart)' AND actor_user_id = 1) = 1);
SELECT pg_temp.check('AU03 bootstrap write without app.user_id: actor NULL, db_role recorded',
  (SELECT actor_user_id IS NULL AND db_role = 'docs_app' FROM audit_log WHERE entity_type = 'app_user' AND action = 'CREATE'));
SELECT pg_temp.check('AU04 password value never stored',
  (SELECT NOT (new_value ? 'password_hash') FROM audit_log WHERE entity_type = 'app_user' AND action = 'CREATE'));

-- AU05 UPDATE: exact old/new values and changed fields
BEGIN;
SELECT set_config('app.user_id', '1', true);
UPDATE screen SET documentation_status = 'DRAFT', risks = 'Filtro frágil' WHERE id = 100;
COMMIT;
SELECT pg_temp.check('AU05 UPDATE with old/new values and changed_fields',
  (SELECT changed_fields = ARRAY['documentation_status','risks']
      AND old_value ->> 'documentation_status' = 'UNDOCUMENTED'
      AND new_value ->> 'documentation_status' = 'DRAFT'
     FROM audit_log WHERE entity_type = 'screen' AND entity_id = '100' AND action = 'UPDATE'),
  '(changed_fields = {documentation_status,risks})');

-- AU06 no-op update records nothing
BEGIN;
SELECT set_config('app.user_id', '1', true);
UPDATE screen SET risks = 'Filtro frágil' WHERE id = 100;
COMMIT;
SELECT pg_temp.check('AU06 no-op UPDATE is not recorded',
  (SELECT count(*) = 1 FROM audit_log WHERE entity_type = 'screen' AND entity_id = '100' AND action = 'UPDATE'));

-- AU07 password change: field name recorded, values redacted
BEGIN;
SELECT set_config('app.user_id', '1', true);
UPDATE app_user SET password_hash = 'hash-2' WHERE id = 1;
COMMIT;
SELECT pg_temp.check('AU07 password change: name in changed_fields, value redacted',
  (SELECT 'password_hash' = ANY(changed_fields) AND NOT (old_value ? 'password_hash') AND NOT (new_value ? 'password_hash')
     FROM audit_log WHERE entity_type = 'app_user' AND action = 'UPDATE'));

-- AU08 set_config(..., true) is transaction-local: it does not leak to the next transaction
BEGIN;
UPDATE screen SET architecture = 'Galería + formulario' WHERE id = 100;
COMMIT;
SELECT pg_temp.check('AU08 app.user_id does not leak across transactions (actor NULL)',
  (SELECT actor_user_id IS NULL FROM audit_log WHERE entity_type = 'screen' AND 'architecture' = ANY(changed_fields)));

-- AU09 a spoofed / malformed actor is ignored, the write still succeeds
BEGIN;
SELECT set_config('app.user_id', '1 OR 1=1', true);
UPDATE screen SET known_issues = 'Ninguno' WHERE id = 100;
COMMIT;
SELECT pg_temp.check('AU09 malformed app.user_id ignored (actor NULL)',
  (SELECT actor_user_id IS NULL FROM audit_log WHERE entity_type = 'screen' AND 'known_issues' = ANY(changed_fields)));

-- AU10 cascades are audited, including the SET NULL on variable.origin_screen_id
BEGIN;
SELECT set_config('app.user_id', '1', true);
DELETE FROM screen WHERE id = 100;
COMMIT;
SELECT pg_temp.check('AU10 DELETE cascade audited (screen, component, comment, links)',
  (SELECT count(DISTINCT entity_type) FROM audit_log WHERE action = 'DELETE' AND actor_user_id = 1
     AND entity_type IN ('screen','component','comment','screen_variable')) = 4);
SELECT pg_temp.check('AU11 SET NULL on origin_screen_id captured as UPDATE with actor',
  (SELECT count(*) = 1 FROM audit_log WHERE entity_type = 'variable' AND entity_id = '101' AND action = 'UPDATE'
     AND changed_fields = ARRAY['origin_screen_id'] AND new_value -> 'origin_screen_id' = 'null'::jsonb AND actor_user_id = 1));
SELECT pg_temp.check('AU12 record survives deletion and stays readable',
  (SELECT old_value ->> 'name' = 'Solicitudes' FROM audit_log WHERE entity_type = 'screen' AND entity_id = '100' AND action = 'DELETE'));

-- AU13-AU18 the API role cannot bypass or alter the audit
SELECT pg_temp.expect_error('AU13 API role INSERT into audit_log',
  $q$INSERT INTO audit_log (db_role, action, entity_type, entity_id) VALUES ('x','CREATE','screen','1')$q$);
SELECT pg_temp.expect_error('AU14 API role UPDATE audit_log', $q$UPDATE audit_log SET entity_label = 'x'$q$);
SELECT pg_temp.expect_error('AU15 API role DELETE audit_log', $q$DELETE FROM audit_log$q$);
SELECT pg_temp.expect_error('AU16 API role disables the audit trigger', $q$ALTER TABLE screen DISABLE TRIGGER trg_screen_audit$q$);
SELECT pg_temp.expect_error('AU17 API role drops the audit trigger', $q$DROP TRIGGER trg_screen_audit ON screen$q$);
SELECT pg_temp.expect_error('AU18 API role reads Prisma migration history', $q$SELECT * FROM _prisma_migrations$q$);
SELECT pg_temp.expect_error('AU19 API role creates objects in schema public', $q$CREATE TABLE public.x (id int)$q$);

-- AU20-AU21 business events through the controlled entry point
BEGIN;
SELECT set_config('app.user_id', '1', true);
SELECT log_business_event('DOCUMENTATION_APPROVED', 'screen', '1', 'App (OnStart)', '{"from":"IN_REVIEW","to":"APPROVED"}'::jsonb, 1);
COMMIT;
SELECT pg_temp.check('AU20 business event recorded as EVENT with actor',
  (SELECT count(*) = 1 FROM audit_log WHERE action = 'EVENT' AND event_name = 'DOCUMENTATION_APPROVED' AND actor_user_id = 1));
SELECT pg_temp.expect_error('AU21 business event without app.user_id',
  $q$SELECT log_business_event('DOCUMENTATION_APPROVED', 'screen', '1')$q$);

-- AU25 (CP-11) the review decision of a review comment is captured by the audit trigger
--      (no change to migration 3: the trigger stores the whole row)
BEGIN;
SELECT set_config('app.user_id', '1', true);
INSERT INTO comment (screen_id, user_id, text, review_decision)
VALUES (1, 1, 'Missing the risks of the gallery.', 'RETURN');
COMMIT;
SELECT pg_temp.check('AU25 review_decision of a review comment stored in new_value',
  (SELECT count(*) = 1 FROM audit_log
    WHERE entity_type = 'comment' AND action = 'CREATE' AND actor_user_id = 1
      AND new_value ->> 'review_decision' = 'RETURN'
      AND entity_label = 'Missing the risks of the gallery.'));
